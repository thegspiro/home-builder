# Deploying

**On Unraid, follow the step-by-step [Unraid guide](unraid/README.md).** This
page is the short version for any Docker host.

The stack is three containers. CI builds and publishes the `app` and `worker`
images to GHCR.

- `app`: the API.
- `worker`: imports videos, syncs playlists nightly and fetches titles.
- `db`: MySQL 8.4.

The app publishes **no host port**. It is reached only through your existing
`cloudflared` container, behind Cloudflare Access. The worker needs outbound
internet access to reach YouTube, and accepts no connections.

## 1. Cloudflare

1. In the Zero Trust dashboard, create an **Access application** (self-hosted)
   for the hostname you'll use, e.g. `videos.example.com`, with a policy that
   allows the emails you want.
2. Note the application's **AUD tag** and your **team domain**
   (`<team>.cloudflareaccess.com`).
3. In your tunnel, add a **public hostname** for the same hostname with service
   `http://app:8080`.

## 2. Unraid / Docker host

1. Find the Docker network your `cloudflared` container is on:
   `docker inspect <cloudflared-container> --format '{{json .NetworkSettings.Networks}}'`.
   If it's on Unraid's default `bridge`, create a user network
   (`docker network create cloudflared`) and attach `cloudflared` to it.
   Docker only resolves container names such as `app` on user-defined networks.
2. Copy this folder (with `scripts/`) to the server, e.g.
   `/mnt/user/appdata/home-builder/`.
3. `cp .env.example .env`, `chmod 600 .env`, and fill in every value. Generate
   passwords with `openssl rand -hex 24`.
4. `docker compose up -d`, then `docker compose ps`. All three services should
   show `healthy` within a minute or two. The app applies database migrations
   on startup.

If the GHCR package is private, run `docker login ghcr.io` on the server first,
using a GitHub token with `read:packages`.

## Playlist sync

Add your playlist in the app (or `POST /api/playlists`). Then:

- The worker syncs it right away, and every day at `SYNC_TIME` (in `TZ`).
- `yt-dlp` can read **public and unlisted** playlists without a Google login.
  For a **private** playlist, export it with Google Takeout and use the CSV
  import instead.
- When a sync starts failing with `yt-dlp` errors, YouTube has usually changed
  something. Update to the latest image, which carries a newer `yt-dlp`.

Watch the worker with `docker compose logs -f worker`.

## Backups

```sh
scripts/backup.sh                       # to $APPDATA_DIR/backups, keeps 14 days
scripts/backup.sh -o /backups -k 30     # elsewhere, keep 30 days
scripts/restore.sh /backups/homebuilder-20261019-043000.sql.gz
```

- **Backup:** dumps the database with `mysqldump --single-transaction` while
  the app keeps running. A file is written only when the dump completed. Files
  are mode `600`.
- **Restore:** checks the file, takes a `pre-restore` safety backup, stops the
  app and worker, replaces the database and starts them again.
- **Passwords** are read inside the `db` container and never appear on a
  command line.
- **Scheduling:** run `backup.sh` nightly from cron (or Unraid's User Scripts
  plugin).

## Updating

```sh
docker compose pull && docker compose up -d
```

Pin `APP_IMAGE_TAG` to a `sha-…` tag for a fixed version; `latest` follows `main`.

## Rolling back a migration

Restore from a backup when possible (`scripts/restore.sh`). To roll back the most recent migration in
place, stop the app and run:

```sh
docker compose run --rm app node dist/cli/migrate.js down
```

then start the previous image tag.
