# Installing on Unraid

This guide installs Home Builder on an Unraid server next to an existing
`cloudflared` container. It takes about 20 minutes. The commands run in the
Unraid web terminal (the `>_` icon at the top right) or over SSH as `root`.

The finished setup:

- three containers (`db`, `app`, `worker`) managed by Docker Compose;
- the app reachable only through Cloudflare Tunnel + Cloudflare Access, with no
  port opened on the server;
- the data under `/mnt/user/appdata/home-builder/`;
- a nightly database backup, run by the User Scripts plugin.

## Before you start

- **Docker** is enabled (Settings → Docker).
- **Docker Compose:** run `docker compose version`. If it says `docker: 'compose'
  is not a docker command`, install the **Docker Compose Manager** plugin from
  the Apps tab (Community Applications), then check again.
- **User Scripts** plugin, also from the Apps tab, for scheduled backups.
- **`cloudflared` is already running** and connected to your tunnel. Check which
  Docker network it is on:

  ```sh
  docker network inspect Unraid-Cloudflared-Tunnel --format '{{range .Containers}}{{.Name}} {{end}}'
  ```

  The output must include your `cloudflared` container. `.env.example` is
  already set to this network name. If your network is called something else,
  change `CLOUDFLARED_NETWORK` in `.env` in step 3.

## 1. Cloudflare

In the Cloudflare Zero Trust dashboard:

1. **Access → Applications → Add an application → Self-hosted.** Use the
   hostname you want, e.g. `videos.example.com`. Add a policy that allows the
   people who should use the library (by email, or your identity provider).
2. Open the application and copy its **Application Audience (AUD) Tag**.
3. Note your **team domain**: `<team>.cloudflareaccess.com` (Settings →
   Custom pages shows it).
4. **Networks → Tunnels →** your tunnel **→ Public hostname → Add.** Use the
   same hostname, with service type `HTTP` and URL `app:8080`.

   `app` is the container's name on the shared network. If another container
   on that network already answers to `app`, use `home-builder-app-1:8080`
   instead.

## 2. Put the files on the server

```sh
mkdir -p /mnt/user/appdata/home-builder
cd /mnt/user/appdata/home-builder
```

Copy the contents of the repository's `deploy/` folder here, so that
`docker-compose.yml`, `.env.example` and `scripts/` sit directly in this
folder. You can copy over the network share (`\\<server>\appdata\home-builder`)
or download it:

```sh
curl -fsSL https://github.com/thegspiro/home-builder/archive/refs/heads/main.tar.gz \
  | tar -xz --strip-components=2 home-builder-main/deploy
```

The download only works while the repository is public. Otherwise, copy the
files over the share.

## 3. Configure

```sh
cp .env.example .env
chmod 600 .env
openssl rand -hex 24   # run twice: one value for each password below
nano .env
```

Fill in:

| Setting | Value |
|---|---|
| `TZ` | Your time zone, e.g. `America/New_York`. The nightly sync runs at `SYNC_TIME` in this zone. |
| `PUBLIC_ORIGIN` | `https://` plus the hostname from step 1. |
| `CF_ACCESS_TEAM_DOMAIN` | `<team>.cloudflareaccess.com`, without `https://`. |
| `CF_ACCESS_AUD` | The AUD tag from step 1. |
| `ADMIN_EMAILS` | Your email (comma-separated for several). Admins edit the shared library and create houses. |
| `DATABASE_PASSWORD`, `MYSQL_ROOT_PASSWORD` | The two generated values. |

Leave `APPDATA_DIR` as `/mnt/user/appdata/home-builder` unless you put the
files elsewhere. Don't use `$` in any value.

## 4. Start it

If the images on GHCR are private, sign in first with a GitHub token that has
`read:packages`:

```sh
docker login ghcr.io -u <github-user>
```

Then:

```sh
docker compose up -d
docker compose ps
```

After a minute or two, all three containers should show `(healthy)`. The app creates the database tables the first
time it starts.

The containers also appear on Unraid's Docker tab. Manage them with
`docker compose` from this folder, not with the Docker tab's edit or update
buttons: those don't know about the compose file.

## 5. First use

1. Open `PUBLIC_ORIGIN` in a browser and sign in through Cloudflare Access.
2. As an admin, go to **Admin**:
   - **Add your playlist.** `yt-dlp` can read public and unlisted playlists.
     For a private playlist, export it with Google Takeout and use the CSV
     import.
   - **Create a house.** Give its owner's email; the owner can then invite
     others from **House settings**.
3. New videos land in the **Inbox** with suggested tags and rooms. Confirm them
   there.

## 6. Backups

`scripts/backup.sh` writes a consistent, compressed SQL dump of the database
while everything keeps running. The files contain the whole library, so they
are readable by `root` only.

Run one now to check it works:

```sh
/mnt/user/appdata/home-builder/scripts/backup.sh
```

**Nightly backups:** in **Settings → User Scripts → Add new script**, name it
`home-builder-backup`, and set its script to:

```sh
#!/bin/bash
/mnt/user/appdata/home-builder/scripts/backup.sh -o /mnt/user/backups/home-builder -k 30
```

Set the schedule to **Custom**, `30 4 * * *` (04:30, after the 03:00 playlist
sync). `-k 30` keeps 30 days of backups.

- **Where:** keep backups on a share that isn't on the same disk as appdata
  (`/mnt/user/backups` above), and copy them off the server now and then.
- **Default location:** without `-o`, backups go to
  `/mnt/user/appdata/home-builder/backups`.
- **Other backup tools:** if an appdata backup plugin also copies this folder,
  rely on the SQL dumps. A copy of the live `mysql/` folder, taken while MySQL
  is running, may not restore cleanly.

## 7. Restoring

```sh
cd /mnt/user/appdata/home-builder
scripts/restore.sh /mnt/user/backups/home-builder/homebuilder-20261019-043000.sql.gz
```

It asks you to type `RESTORE`, then:

1. checks that the file is a complete Home Builder backup;
2. saves the current database as a `pre-restore` backup next to the file;
3. stops the app and worker, replaces the database, and starts them again.

You can restore an older backup into a newer version of the app: the app brings
the database up to date as it starts. Don't restore a backup from a *newer*
version into an older one. Update the images first.

To move to a new server, install there (steps 1–4), then restore your latest
backup.

## 8. Updating

```sh
cd /mnt/user/appdata/home-builder
docker compose pull
docker compose up -d
```

`latest` follows the main branch. To stay on a fixed version, set
`APP_IMAGE_TAG` in `.env` to one of the `sha-…` tags listed on GHCR. To go
back after a bad update, set the previous tag and restore the backup taken
before the update. Database migrations only move forward on their own.

## Troubleshooting

| Symptom | Check |
|---|---|
| Cloudflare shows **502 / Bad gateway** | `cloudflared` can't reach the app. Run `docker network inspect Unraid-Cloudflared-Tunnel`: it must list both `cloudflared` and `home-builder-app-1`. The tunnel's service URL must be `http://app:8080`. |
| The app answers **401** after signing in | `CF_ACCESS_TEAM_DOMAIN` or `CF_ACCESS_AUD` doesn't match the Access application. `docker compose logs app` shows the reason (`access denied`). |
| **403** when saving anything | `PUBLIC_ORIGIN` must be exactly the address in the browser bar (scheme and host, no trailing slash). |
| `docker compose up` stops with **"Set … in .env"** | That setting is empty in `.env`. |
| `worker` is **unhealthy** | `docker compose logs worker`. It needs outbound internet access to YouTube. |
| Playlist sync fails with **yt-dlp errors** | YouTube changed something. `docker compose pull` gets the newest `yt-dlp`. |
| **Docker image disk full** | Each container's log is capped at 30 MB. Look for other containers' logs, or old images: `docker image prune`. |

## Removing

```sh
cd /mnt/user/appdata/home-builder
docker compose down
```

This keeps the data. To delete everything, remove
`/mnt/user/appdata/home-builder` afterwards, and the tunnel's public hostname
in Cloudflare.
