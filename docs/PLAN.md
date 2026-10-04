# Home Builder Video Library — Implementation Plan

Status: **Draft — awaiting confirmation of open questions (section 10) before implementation.**

## 1. Goal

A self-hosted library of YouTube videos about home building, repair, and
maintenance, replacing a single unsorted playlist. Videos can be found three ways:

1. **Tag search** — free-text search plus tag filters.
2. **List** — sortable, filterable table of all videos.
3. **3D house** — a stylized house; selecting an area (e.g. Garage) shows the
   videos assigned to it (garage door install, painting, insulation, …).

## 2. Confirmed decisions

| Topic | Decision |
|---|---|
| Video source | YouTube playlist(s): `yt-dlp` flat sync (public/unlisted) **and** Google Takeout CSV upload (private) |
| Metadata | YouTube oEmbed (no API key): title, channel, thumbnail |
| Classification | Editable keyword rules suggest tags/areas on import; manual confirm/edit in UI |
| Database | Bundled MySQL 8.4 LTS container |
| Exposure | Internet via Cloudflare Tunnel + Cloudflare Access |
| Auth in app | Validate the Cloudflare Access JWT on every request; no LAN bypass |
| Roles | Any Access-authenticated user can browse; emails in `ADMIN_EMAILS` can edit |
| 3D house | Generic stylized low-poly house, built procedurally in Three.js |
| Areas | Interior rooms, exterior, whole-house systems, workshop/general skills |
| Frontend | Vanilla TypeScript + Vite + Three.js (no UI framework) |

## 3. Architecture

```
 Browser ──HTTPS──▶ Cloudflare Access ──▶ cloudflared tunnel ──▶ app (Node/TS)
                                                                  │   │
                                                       static UI ◀┘   │ SQL (mysql2, parameterized)
                                                                      ▼
                                              worker (Python) ◀──▶ MySQL 8.4
                                              (polls import_jobs)
```

Three containers in one `docker-compose.yml` on a private Docker network:

| Service | Stack | Responsibility |
|---|---|---|
| `app` | Node 22, TypeScript, Fastify, Kysely + mysql2, `jose` | REST API, Access JWT validation, serves built frontend, runs DB migrations on start |
| `worker` | Python 3.12, `yt-dlp`, `requests`, `PyMySQL` | Executes import jobs: playlist sync, CSV import, oEmbed metadata fetch, keyword-rule suggestions |
| `db` | `mysql:8.4` | Persistent storage under the Unraid appdata share |

Job hand-off uses a MySQL `import_jobs` table claimed with
`SELECT … FOR UPDATE SKIP LOCKED`, so no extra broker (Redis/RabbitMQ) is needed
and the worker can be scaled or restarted safely.

## 4. Repository layout (proposed)

```
app/            TypeScript API + migrations (Kysely)
  src/  test/
web/            Vite frontend: index (search), list, house (Three.js), admin
  src/  test/
worker/         Python import worker
  src/  tests/
deploy/
  docker-compose.yml
  .env.example
  unraid/       Unraid notes / template
scripts/        POSIX sh: backup.sh (mysqldump), restore.sh
docs/PLAN.md
```

## 5. Data model (MySQL, utf8mb4)

| Table | Key columns |
|---|---|
| `videos` | `id`, `youtube_id` UNIQUE (11-char validated), `title`, `channel_name`, `thumbnail_url`, `notes`, `source` ENUM(playlist,csv,manual), `review_status` ENUM(inbox,sorted), `metadata_status` ENUM(pending,ok,unavailable), timestamps; FULLTEXT(`title`,`channel_name`,`notes`) |
| `tags` | `id`, `slug` UNIQUE, `name` |
| `video_tags` | (`video_id`, `tag_id`) PK, FKs cascade |
| `areas` | `id`, `slug` UNIQUE, `name`, `category` ENUM(interior,exterior,system,workshop), `sort_order` — seeded |
| `video_areas` | (`video_id`, `area_id`) PK, `suggested` BOOL (rule-suggested vs. confirmed) |
| `keyword_rules` | `id`, `phrase`, `tag_id` NULL, `area_id` NULL, `enabled` |
| `playlists` | `id`, `youtube_playlist_id` UNIQUE, `title`, `last_synced_at` |
| `import_jobs` | `id`, `type` ENUM(playlist_sync,csv_import,metadata_refresh), `payload` JSON, `status`, `error`, `created_by`, timestamps |
| `audit_log` | `id`, `actor_email`, `action`, `entity`, `entity_id`, `details` JSON, `created_at` |

Seeded areas:

- **Interior:** kitchen, bathroom, bedroom, living room, laundry, basement, attic, garage
- **Exterior:** roof & gutters, siding & windows, exterior doors, deck/porch, foundation, driveway, yard/landscaping
- **Systems:** electrical, plumbing, HVAC, insulation, framing, drywall & paint
- **Workshop:** tools, safety, general skills

Migrations are versioned, forward-only in production with matching `down`
scripts for rollback; seeds use `INSERT … ON DUPLICATE KEY UPDATE` so they are
idempotent.

## 6. Features by view

**Search** — query box (MySQL FULLTEXT, boolean mode, input sanitized), tag chips
(AND filter), area filter, results as thumbnail cards.

**List** — paginated table: title, channel, tags, areas, date added; sort and
filter by tag/area/review status. Admins get inline edit and bulk tag/area assign.

**3D house** — orbit camera around a cutaway ("dollhouse") house; hover
highlights an area, click flies the camera in and opens a side panel of videos.
Exterior parts (roof, siding, deck, driveway…) are clickable from outside.
Systems (electrical, plumbing, HVAC, insulation, framing, drywall) are
toggleable overlays (wires, pipes, ducts) that select the system's videos.
A detached shed is the Workshop. A plain area menu is always available as a
keyboard-accessible fallback, used automatically when WebGL is unavailable.

**Video playback** — opens on YouTube or in an embedded `youtube-nocookie.com`
player.

**Admin** — inbox of new/unsorted videos with rule suggestions to accept,
playlist management + "Sync now", CSV upload, keyword rule editor, tag management.

## 7. Security

- **Cloudflare Access JWT** (`Cf-Access-Jwt-Assertion` header) verified with
  `jose` against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`,
  checking signature, `aud`, `iss`, `exp`. Missing/invalid → 401. Configured via
  `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` env vars.
- **Authorization:** editing endpoints require the JWT email in `ADMIN_EMAILS`.
- **No published host port** when `cloudflared` shares the Docker network, so the
  app cannot be reached around Access (see open question 10.1).
- **CSRF:** mutating requests must be JSON and pass an `Origin` check against
  `PUBLIC_ORIGIN`.
- **Headers:** strict CSP (frame-src limited to `youtube-nocookie.com`), HSTS
  handled by Cloudflare, `X-Content-Type-Options`, `Referrer-Policy`.
- **Input validation:** Fastify JSON schemas on every route; YouTube IDs and
  playlist IDs validated by regex; CSV uploads size-limited and parsed with
  Python's `csv` module (no `eval`/pickle).
- **SQL:** parameterized queries only (Kysely / PyMySQL params).
- **Shell:** `yt-dlp` run via `subprocess` with an argument list (no shell),
  `--flat-playlist --skip-download`, with a timeout.
- **Secrets:** env vars only; `.env.example` documents them, real `.env` git-ignored.
- **Audit log** for every admin mutation.

## 8. Testing

| Layer | Tooling |
|---|---|
| API unit + route tests | Vitest + Fastify `inject`, JWT verification tested with locally generated keys |
| DB integration + migrations (up/down/idempotent seed) | Vitest against a MySQL 8.4 test container |
| Worker | pytest; yt-dlp and oEmbed mocked; CSV fixtures; job claiming against MySQL |
| Frontend | Vitest for modules; Playwright smoke test (search, list, house loads and area click opens panel) |
| CI | GitHub Actions: lint, typecheck, test, build images |

## 9. Delivery phases (one PR each)

1. **Foundation** — repo scaffolding, compose, MySQL migrations + seeds, Access
   JWT middleware, health endpoint, CI.
2. **Import pipeline** — worker, playlist sync, CSV import, oEmbed, keyword rules, inbox API.
3. **Search & list UI** — plus admin editing.
4. **3D house** — Three.js scene, areas, overlays, fallback menu.
5. **Ops** — backup/restore scripts, Unraid install guide, hardening review.

## 10. Open questions

1. Do you already run `cloudflared` on Unraid (as a container or plugin), or
   should it be included in this compose stack? If it's separate, is it on a
   Docker network the app can join, or does it reach services by host IP:port?
2. Appdata path: OK to use `/mnt/user/appdata/home-builder/` (MySQL data, uploads)?
3. Images: build on the Unraid server from the repo, or publish to GHCR via
   GitHub Actions and pull?
4. Playlist sync: manual "Sync now" only, or also on a schedule (e.g. nightly)?
