# Home Builder Video Library — Implementation Plan

Status: **Agreed. One open item: the `cloudflared` Docker network name (section 11). It doesn't block Phase 1.**

## 1. Goal

A self-hosted library of YouTube videos about home building, repair, and
maintenance, replacing a single unsorted playlist. Videos can be found three ways:

1. **Tag search**: free-text search plus tag filters.
2. **List**: a sortable, filterable table of all videos.
3. **3D house**: a stylized house. Selecting an area (for example the Garage)
   shows the videos for that area (garage door install, painting, insulation, …).

The app supports **multiple houses**. Each house has its own rooms and its own
idea of where things are. For example, the electrical panel is in the garage in
one house and in the basement in another. Houses are shared between users
through per-house roles.

## 2. Confirmed decisions

| Topic | Decision |
|---|---|
| Video source | YouTube playlist(s): `yt-dlp` flat sync (public/unlisted) **and** Google Takeout CSV upload (private playlists) |
| Metadata | YouTube oEmbed (no API key): title, channel, thumbnail |
| Classification | Keyword rules you can edit suggest tags, area types and items on import; you confirm or change them in the UI |
| Database | MySQL 8.4 LTS container, included in the compose stack |
| Exposure | Internet via Cloudflare Tunnel + Cloudflare Access; your existing `cloudflared` container joins a shared Docker network; no host port is published |
| Auth in app | Validate the Cloudflare Access JWT on every request; no LAN bypass |
| Library | Shared catalog edited by global admins (`ADMIN_EMAILS`), **plus** house-private videos visible only to that house's members |
| Houses | Multiple houses; per-house roles (owner / editor / viewer) by email; global admins create houses |
| Locations | Each house can add, rename and hide its own areas, and choose where items (panel, water heater, …) are placed |
| 3D house | Generic stylized low-poly house, built in code with Three.js |
| Area types | Interior rooms, exterior, whole-house systems, workshop/general skills |
| Frontend | Vanilla TypeScript + Vite + Three.js (no UI framework) |
| Images | Published to GHCR by GitHub Actions and pulled on Unraid |
| Playlist sync | Nightly, plus a "Sync now" button |

## 3. Architecture

```
 Browser ──HTTPS──▶ Cloudflare Access ──▶ cloudflared (existing container)
                                              │  shared Docker network
                                              ▼
                                        app (Node/TS) ── serves static UI
                                              │ SQL (parameterized)
                                              ▼
                     worker (Python) ◀──▶ MySQL 8.4
                     (polls import_jobs, nightly sync)
```

| Service | Stack | Responsibility |
|---|---|---|
| `app` | Node 22, TypeScript, Fastify, Kysely + mysql2, `jose` | REST API, Access JWT validation, authorization, serves the built frontend, runs DB migrations on startup |
| `worker` | Python 3.12, `yt-dlp`, `requests`, `PyMySQL` | Import jobs: playlist sync, CSV import, oEmbed metadata, keyword-rule suggestions, nightly sync scheduler |
| `db` | `mysql:8.4` | Data stored under the Unraid appdata share |

The app hands jobs to the worker through a MySQL `import_jobs` table. The worker
claims jobs with `SELECT … FOR UPDATE SKIP LOCKED`, so no extra message broker
is needed and restarts are safe. The nightly sync takes a MySQL advisory lock
(`GET_LOCK`), so two worker replicas cannot run it twice.

## 4. Repository layout (proposed)

```
app/            TypeScript API + migrations (Kysely)
web/            Vite frontend: search, list, house (Three.js), house settings, admin
worker/         Python import worker
deploy/
  docker-compose.yml
  .env.example
  unraid/       Unraid install notes
scripts/        POSIX sh: backup.sh (mysqldump), restore.sh
.github/workflows/  CI + GHCR image publishing
docs/PLAN.md
```

## 5. Data model (MySQL, utf8mb4)

### 5.1 Concepts

- **Area type** (global catalog): a kind of place or system, such as Garage,
  Kitchen, Roof & gutters or Electrical. Shared videos are linked to area types.
- **Item** (global catalog): a thing that lives somewhere, such as an
  electrical panel, water heater, furnace or sump pump. Shared videos can be
  linked to items.
- **House**: one home layout. It has **house areas** (rooms) and **item
  placements**.
- **House area**: a room in one house. It usually maps to an area type
  ("Garage" → Garage). It can be renamed ("Two-car garage"), hidden, or custom
  ("Mudroom"). A custom area can optionally map to an area type, so it shows
  that type's videos.

A video appears in house area **X** of house **H** when any of these is true:

1. the video is linked to X's area type, or
2. the video is linked to an item that H has placed in X, or
3. the video is private to H and linked directly to X.

Moving the panel from Garage to Basement in one house moves its videos there
for that house only.

### 5.2 Tables

| Table | Key columns |
|---|---|
| `area_types` | `id`, `slug` UNIQUE, `name`, `category` ENUM(interior,exterior,system,workshop), `default_zone`, `sort_order` (seeded) |
| `items` | `id`, `slug` UNIQUE, `name`, `system_area_type_id` NULL (e.g. Electrical), `whole_house` BOOL (shown in every interior area) (seeded) |
| `item_default_placements` | (`item_id`, `area_type_id`): where an item goes when a house is created |
| `houses` | `id`, `name`, `created_by`, timestamps |
| `house_members` | (`house_id`, `email`) PK, `role` ENUM(owner,editor,viewer) |
| `house_areas` | `id`, `house_id`, `area_type_id` NULL, `name`, `zone` (3D slot), `hidden`, `sort_order` |
| `house_item_placements` | (`house_id`, `item_id`, `house_area_id`) PK; an item can be in more than one area |
| `videos` | `id`, `youtube_id` (11 characters, validated), `house_id` NULL (NULL = shared, set = private), `title`, `channel_name`, `thumbnail_url`, `notes`, `source` ENUM(playlist,csv,paste,manual), `review_status` ENUM(inbox,sorted), `metadata_status` ENUM(pending,ok,unavailable), timestamps; UNIQUE(`youtube_id`, `house_scope`)\*; FULLTEXT(`title`,`channel_name`,`notes`) |
| `tags` | `id`, `house_id` NULL (NULL = shared tag, set = house tag), `slug`, `name`, `kind` ENUM(topic,skill,task,other); UNIQUE(`slug`, `house_scope`) |
| `video_tags` | (`video_id`, `tag_id`) |
| `video_area_types` | (`video_id`, `area_type_id`), `suggested` BOOL |
| `video_items` | (`video_id`, `item_id`), `suggested` BOOL |
| `video_house_areas` | (`video_id`, `house_area_id`): private videos only, enforced in the API |
| `keyword_rules` | `id`, `phrase`, `tag_id` / `area_type_id` / `item_id` (one target), `enabled` |
| `playlists` | `id`, `youtube_playlist_id` UNIQUE, `title`, `last_synced_at` |
| `import_jobs` | `id`, `type`, `payload` JSON, `status`, `error`, `created_by`, timestamps |
| `audit_log` | `id`, `actor_email`, `house_id` NULL, `action`, `entity`, `entity_id`, `details` JSON, `created_at` |

\* MySQL treats NULLs as distinct in UNIQUE indexes. `house_scope` is a stored
generated column, `COALESCE(house_id, 0)`, so a video is unique within the
shared library and within each house. `tags` uses the same pattern.

### 5.3 Seeds

- **Interior:** kitchen, bathroom, bedroom, living room, laundry, basement, attic, garage
- **Exterior:** roof & gutters, siding & windows, exterior doors, deck/porch, foundation, driveway, yard/landscaping
- **Systems:** electrical, plumbing, HVAC, insulation, framing, drywall & paint
- **Workshop:** tools, safety, general skills
- **Items, with default placement.** Owners can move any of these, place one
  in several areas, or hide it if the house doesn't have it (e.g. no well, no
  septic).

  | Area | Items |
  |---|---|
  | Garage | electrical panel (main), garage door, garage door opener, water heater |
  | Basement | furnace, sump pump, water main shutoff, water softener, dehumidifier, pressure tank (well), electrical sub-panel, gas shutoff |
  | Kitchen | sink & faucet, garbage disposal, dishwasher, range hood, refrigerator water line, cabinets, countertops |
  | Bathroom | toilet, shower/tub, vanity & faucet, exhaust fan, GFCI outlets |
  | Laundry | washer hookups, dryer & dryer vent |
  | Living room | fireplace, ceiling fan |
  | Bedroom | closet, windows (interior trim) |
  | Attic | attic insulation, attic fan / ventilation, attic access |
  | Roof & gutters | shingles, flashing, gutters & downspouts, chimney |
  | Siding & windows | siding, exterior windows, caulking & weatherstripping |
  | Exterior doors | entry door, sliding/patio door, storm door |
  | Deck/porch | deck boards, railings |
  | Foundation | foundation walls, crawlspace, grading & drainage |
  | Driveway | driveway, walkways |
  | Yard/landscaping | hose bibs, irrigation, well pump, septic tank, fence, AC condenser / heat pump, electric meter, gas meter |
  | Whole house (shown in every interior area) | thermostat, smoke & CO detectors, outlets & switches, light fixtures, interior doors, flooring, drywall |

- **Shared tags (seeded).**
  - *Task:* install, repair, replace, maintenance, inspection, troubleshooting, upgrade, renovation, new construction, seasonal
  - *Skill level:* beginner, intermediate, advanced, hire a pro
  - *Topic:* safety, code & permits, energy efficiency, cost saving, water damage, mold, pests, weatherproofing, storm prep
  - *Trade:* carpentry, painting, tiling, flooring, concrete, roofing, plumbing, electrical, HVAC, drywall, landscaping, welding
  - *Tools:* hand tools, power tools, measuring, tool maintenance

A new house gets one house area per visible area type, plus the default item
placements, which owners and editors can then change.

### 5.4 Migrations

Migrations are versioned Kysely migrations with matching `down` functions for
rollback. Seeds use `INSERT … ON DUPLICATE KEY UPDATE`, so they can be re-run
safely. Every migration is tested up → down → up against MySQL 8.4 in CI.

## 6. Roles and permissions

| Action | Global admin | House owner | House editor | House viewer |
|---|---|---|---|---|
| Browse shared library | ✓ | ✓ | ✓ | ✓ |
| Edit shared library (videos, shared tags, rules, area types, items, playlists, CSV) | ✓ | | | |
| Create / delete houses | ✓ | | | |
| Manage house members | ✓ | ✓ | | |
| Add/rename/hide house areas, move items | ✓ | ✓ | ✓ | |
| Add/edit house-private videos (one URL, pasted list, or CSV) | ✓ | ✓ | ✓ | |
| Create/edit house tags; apply any tag to private videos | ✓ | ✓ | ✓ | |
| See house-private videos | ✓ | ✓ | ✓ | ✓ |

A user who isn't a member of any house can still browse the shared library and
the default layout (read-only).

## 7. Features by view

A **house selector** in the header sets the context. Search, List and House
views then show shared videos plus that house's private videos, laid out using
that house's rooms.

**Search**: a query box (MySQL FULLTEXT in boolean mode, with operators
stripped from user input), tag chips (AND filter), an area filter, and results
as thumbnail cards.

**List**: a paginated table with title, channel, tags, areas and date added.
Sort and filter by tag, area or review status. Editors get inline editing and
bulk assignment within their permissions.

**3D house**: an orbit camera around a cutaway ("dollhouse") house built from
fixed **zones** (ground-floor rooms, upstairs, basement, attic, garage, exterior
faces, yard, detached workshop shed). Each house area is drawn in a zone. Custom
areas share a zone and appear as labeled sub-spaces. Hovering highlights an
area. Clicking flies the camera in and opens a side panel with the area's
videos. Placed items appear as clickable objects in their room (for example, a
panel box on the garage wall). Systems are overlays you can toggle (wires,
pipes, ducts). A plain, keyboard-accessible area menu is always available and is
used automatically when WebGL isn't available.

**House settings** (owner/editor): rename, hide or add areas; drag items between
areas; manage members (owner only).

**Admin** (global): an inbox of new, unsorted videos with rule suggestions to
accept; playlist management and "Sync now"; CSV upload; the keyword-rule editor;
and management of tags, area types and items.

**Playback**: opens on YouTube or in an embedded `youtube-nocookie.com` player.

## 8. Security

- **Cloudflare Access JWT** (`Cf-Access-Jwt-Assertion` header), verified with
  `jose` against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`,
  checking signature, `aud`, `iss` and `exp`. A missing or invalid token gets a
  401. Configured through the `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`
  environment variables.
- **Authorization** happens in one place in the API (a policy module). Every
  query that touches a house filters by the caller's membership, so private
  videos never leak between houses. There are dedicated tests for
  cross-house access.
- **Network:** the app has no published host port. It is reachable only on the
  Docker network shared with `cloudflared`. MySQL is reachable only on the
  internal stack network.
- **CSRF:** requests that change data must be JSON and pass an `Origin` check
  against `PUBLIC_ORIGIN`.
- **Headers:** a strict CSP (frames limited to `youtube-nocookie.com`),
  `X-Content-Type-Options` and `Referrer-Policy`. Cloudflare handles HSTS.
- **Input validation:** Fastify JSON schemas on every route; regex checks on
  YouTube video and playlist IDs and on member emails; size limits on CSV
  uploads, which are parsed with Python's `csv` module (no `eval` or pickle).
- **SQL:** parameterized queries only.
- **Shell:** `yt-dlp` is run with `subprocess` and an argument list (no shell),
  `--flat-playlist --skip-download`, and a timeout.
- **Secrets:** environment variables only. `.env.example` documents them; the
  real `.env` is git-ignored.
- **Audit log** records every change.

## 9. Testing

| Layer | Tooling |
|---|---|
| API unit + route tests | Vitest + Fastify `inject`; JWT checks tested with locally generated keys; permission matrix (section 6) tested as a table |
| DB integration + migrations | Vitest against a MySQL 8.4 container (up/down/up, seeds can be re-run, visibility resolution from 5.1) |
| Worker | pytest; yt-dlp and oEmbed mocked; CSV fixtures; job claiming and nightly lock tested against MySQL |
| Frontend | Vitest for modules; Playwright smoke test (house selector, search, list, house loads, clicking an area opens the panel, moving an item updates the panel) |
| CI | GitHub Actions: lint, typecheck, tests; build and push images to GHCR on `main` |

## 10. Delivery phases (one PR each)

1. **Foundation**: scaffolding, compose, migrations and seeds, Access JWT
   middleware, permission module, health endpoint, CI and GHCR publishing.
2. **Houses**: house, member, area and item-placement APIs, with
   cross-house access tests.
3. **Import pipeline**: worker, playlist sync (manual + nightly), CSV import,
   oEmbed, keyword rules, inbox.
4. **Search & list UI**: house selector, search, list, admin and house settings
   pages.
5. **3D house**: Three.js scene, zones, items, overlays, fallback menu.
6. **Ops**: backup/restore scripts, Unraid install guide, hardening review.

## 11. Resolved decisions and open items

1. **Tags:** global admins manage the seeded **shared tags** (section 5.3).
   House owners and editors can create **house tags**, which only that house's
   members see. Both kinds can be applied to that house's private videos, and
   a house tag never shows up in another house.
2. **Private videos:** house editors add them one URL at a time, or **in
   bulk** by pasting a list of URLs (one per line, up to 500) or uploading a
   Takeout-style CSV. Bulk adds run as worker jobs scoped to that house; any
   duplicates and invalid URLs are reported back. Nightly playlist sync feeds
   only the shared library.
3. **Appdata path:** `/mnt/user/appdata/home-builder/` (overridable with
   `APPDATA_DIR`).
4. **Open: Docker network name** for `cloudflared`. Compose reads it from
   `CLOUDFLARED_NETWORK` in `.env`, so this only needs to be filled in at
   deploy time.
5. **Nightly sync time:** 03:00 server local time (overridable with
   `SYNC_CRON`).
