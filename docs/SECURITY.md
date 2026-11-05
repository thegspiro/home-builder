# Security review

This is the Phase 6 hardening review of the whole stack: what protects the app, what
was checked, what changed as a result, and the risks that remain. Re-read it when
deployment or authentication changes.

## What is being protected

- **The video library.** Titles, notes and tags are low sensitivity. House-private
  videos and house layouts are visible only to that house's members.
- **Who uses the app.** Member emails and roles, and the audit log.
- **The server.** The containers run on a home Unraid server that also hosts other
  services.

The main threats are someone on the internet reaching the app without being allowed
in, a signed-in user reaching another house's data or doing more than their role
allows, and injection through imported data (YouTube titles, CSV files, pasted text).

## Controls, as checked in this review

### Network and exposure

- **No published ports.** `docker-compose.yml` publishes no host port. The app is
  reachable only from the `cloudflared` container on the shared network
  (`CLOUDFLARED_NETWORK`).
- **MySQL** is on an `internal: true` network with no route out. Only `app` and
  `worker` can reach it.
- **The worker** gets outbound internet access (YouTube) through its own `egress`
  network and accepts no connections.
- **No LAN bypass.** Every request, including ones from the LAN, needs a valid
  Cloudflare Access token. The only exception is `GET /healthz`, which returns no
  data.

### Authentication (`app/src/auth/access.ts`)

- **The token is fully verified.** The `Cf-Access-Jwt-Assertion` JWT is checked for:
  - an RS256 signature against the team's published keys;
  - issuer `https://<team>.cloudflareaccess.com`, and audience equal to the Access
    application's AUD tag;
  - required `exp` and `iat` claims, with 30 seconds of clock tolerance.
- **People only.** Service tokens (no email claim) are rejected. Emails are
  normalized to lower case.
- **The header is redacted from logs.**

### Authorization (`app/src/auth/policy.ts`, `app/src/houses/access.ts`)

- **One policy module** decides every action for global admins (`ADMIN_EMAILS`) and
  for per-house owners, editors and viewers.
- **No probing of other houses.** A house the caller isn't a member of answers 404,
  not 403, so house IDs can't be discovered. Every house query filters by
  membership.
- **Tested:** the integration tests cover cross-house access, the role matrix, and
  races on membership changes.

### Requests and data

- **CSRF:**
  - Every non-GET request must carry `Origin` equal to `PUBLIC_ORIGIN`.
  - Only JSON bodies are parsed (the `text/plain` parser is removed), so a
    cross-site form can't reach a handler.
- **Input validation:**
  - Every route has a Fastify JSON schema.
  - YouTube video and playlist IDs and member emails are checked with regexes.
  - Size limits: 1 MB per body, 200,000 characters of pasted text, 2,000,000
    characters of CSV.
- **SQL:**
  - All queries are built with Kysely and parameterized.
  - The only `sql.raw` use is the fixed DDL in the first migration.
  - Search input is reduced to letters and digits before it reaches the full-text
    or regular-expression match.
- **Shell:**
  - `yt-dlp` runs from the worker with an argument list, never a shell.
  - It gets `--` before the URL, a validated playlist ID, `--ignore-config` and a
    timeout.
- **Deserialization:**
  - The worker parses CSV with Python's `csv` module and JSON with `json`.
  - There is no `pickle`, `eval` or YAML.
- **Errors:**
  - 500 responses carry no details; stack traces go to the logs only.
  - Job errors shown in the UI are short, safe messages.
- **Audit log:** every change writes an `audit_log` row.

### Browser

- **Content-Security-Policy:**
  - `default-src 'self'`, with no inline scripts.
  - Images: `'self'`, `i.ytimg.com`, `data:`.
  - Frames: `www.youtube-nocookie.com` only.
  - `frame-ancestors 'none'` and `object-src 'none'`.
- **Other headers:** `X-Content-Type-Options: nosniff`, and Helmet's default
  `Referrer-Policy: no-referrer`.
- **Permissions-Policy** (new in this phase) switches off camera, microphone,
  geolocation, payment, USB and the motion sensors. It leaves fullscreen,
  picture-in-picture and encrypted media for the YouTube player.
- **Safe DOM building:**
  - All page content is built with `textContent` and `setAttribute`.
  - ESLint forbids `innerHTML`, `outerHTML` and `insertAdjacentHTML`.
  - URLs in links and media must be http(s); `javascript:` and `data:` are
    dropped.
- **Privacy:** videos play in YouTube's privacy-enhanced embed
  (`youtube-nocookie.com`).

### Containers

| | `app` | `worker` | `db` |
|---|---|---|---|
| Runs as | `node` (uid 1000) | `worker` (uid 10001) | `mysql` (uid 999, dropped by the image's entrypoint) |
| Read-only root filesystem | yes (`/tmp` is tmpfs) | yes (`/tmp` is tmpfs) | no (MySQL needs to write) |
| `cap_drop: ALL` | yes | yes | no (the entrypoint needs to change user) |
| `no-new-privileges` | yes | yes | yes (new in this phase) |
| Health check | `/healthz` | heartbeat file | `mysqladmin ping` |
| Log rotation | 3 × 10 MB | 3 × 10 MB | 3 × 10 MB (new in this phase) |

- **Images** contain production dependencies only; the app image has no dev or
  test tooling.
- **CI** builds and publishes the images from `main` only, with a token scoped to
  `packages: write`.

### Secrets and backups

- **Secrets** live only in `.env`, which is git-ignored. The docs say to `chmod 600`
  it.
- **Database passwords** are passed as environment variables. They never appear on
  a command line: the MySQL health check and the backup and restore scripts read
  them inside the container.
- **Backups** (`deploy/scripts/backup.sh`) are created with `umask 077` (mode
  `600`). A file only appears once the dump completed and passed `gzip -t`.
- **Restore** checks the file before touching anything, takes a safety backup, and
  refuses to run unattended without `-y`.

## Changes made in this phase

1. **`Permissions-Policy` header** on every response, including 401s
   (`app/src/app.ts`; unit tested).
2. **`db` container hardening:**
   - `no-new-privileges`. MySQL 8.4 was checked to start normally with it.
   - A 1-minute stop grace period, so InnoDB shuts down cleanly instead of being
     killed after Docker's default 10 seconds.
3. **Log rotation** for all three containers. Docker otherwise keeps logs forever,
   which can fill Unraid's `docker.img`.
4. **Backup and restore scripts**, with an end-to-end test in CI. Before this
   phase, the only rollback path was manual.

## Remaining risks and recommendations

- **Cloudflare Access is the front door.**
  - The app trusts whoever Access lets through, and then applies its own roles.
  - Keep the Access policy limited to people who should use the library.
  - Keep `ADMIN_EMAILS` short.
- **No rate limiting in the app.**
  - Unauthenticated requests never reach it (Access answers them).
  - Signed-in users are trusted not to flood it. If that changes, add Cloudflare
    rate-limiting rules for the hostname.
- **Import payloads are kept.**
  - `import_jobs.payload` keeps the pasted text or CSV of each import.
  - It is only visible to the people who could run that import.
  - It could be cleared once a job finishes. That is a small follow-up if wanted.
- **Images follow `latest` by default.** For a fixed, reviewable version, pin
  `APP_IMAGE_TAG` to a `sha-…` tag, and `mysql:8.4` to a digest.
- **`MYSQL_ROOT_PASSWORD` is in the `db` container's environment.** That is the
  official image's design. Anyone who can run `docker` on the server can read it,
  as they can everything else on the server.
- **Backups contain the whole library** (house-private videos and member emails).
  Store them on a share only you can read, and keep an off-server copy.
- **Each new `yt-dlp` release** runs with network access in the worker. It is
  pinned in `worker/requirements.txt` and updated through reviewed PRs.
