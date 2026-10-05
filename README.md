# home-builder

A self-hosted library of YouTube videos about home building, repair and
maintenance. Find a video by tag search, in a list, or by walking through a 3D
house where each room shows its videos. Multiple houses, each with its own
layout, can share one library.

- **Plan and design:** [docs/PLAN.md](docs/PLAN.md)
- **Deploying on Unraid / Docker:** [deploy/README.md](deploy/README.md)

## Repository layout

| Path | What |
|---|---|
| `app/` | TypeScript API (Fastify, Kysely, MySQL), migrations and seed catalog |
| `web/` | Browser pages (plain TypeScript + Vite, no framework): Search, List, Inbox, House settings, Admin. The app serves the built pages. |
| `worker/` | Python import worker: playlist sync (`yt-dlp`), CSV/paste imports, oEmbed metadata, keyword rules, nightly schedule. See [docs/JOBS.md](docs/JOBS.md) |
| `deploy/` | `docker-compose.yml` and `.env.example` |
| `.github/workflows/` | CI: lint, typecheck, unit and MySQL integration tests, Playwright browser tests; publishes both images to GHCR from `main` |

## Development

Requires Node 22 and a disposable MySQL 8.4 database.

```sh
cd app
npm ci
npm run lint && npm run typecheck && npm run test:unit

# Integration tests drop every table in the target database, so its name must contain "test".
docker run -d --name hb-test-mysql -p 3306:3306 \
  -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=homebuilder_test \
  -e MYSQL_USER=homebuilder -e MYSQL_PASSWORD=homebuilder mysql:8.4
DATABASE_HOST=127.0.0.1 DATABASE_NAME=homebuilder_test \
DATABASE_USER=homebuilder DATABASE_PASSWORD=homebuilder npm run test:integration
```

### Web pages and browser tests

```sh
cd web
npm ci
npm run lint && npm run typecheck && npm test
npm run build            # → web/dist, served by the app when WEB_ROOT points at it

# Browser tests run the real app and pages against the test database (from app/):
cd ../app
DATABASE_HOST=127.0.0.1 DATABASE_NAME=homebuilder_test \
DATABASE_USER=homebuilder DATABASE_PASSWORD=homebuilder npm run test:e2e
```

Run `npx playwright install chromium` once first, or set `PW_CHROMIUM_EXECUTABLE`
to an existing Chromium.

The app image builds from the repository root, because it includes the pages:
`docker build -f app/Dockerfile .`

### Worker

Requires Python 3.11 or later. Its integration tests use the same disposable
database, after the app's migrations have created the schema.

```sh
cd worker
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
ruff format --check . && ruff check . && pytest tests/unit

(cd ../app && npm run build && DATABASE_HOST=127.0.0.1 DATABASE_NAME=homebuilder_test \
  DATABASE_USER=homebuilder DATABASE_PASSWORD=homebuilder node dist/cli/migrate.js)
DATABASE_HOST=127.0.0.1 DATABASE_NAME=homebuilder_test \
DATABASE_USER=homebuilder DATABASE_PASSWORD=homebuilder pytest tests/integration
```

Migrations run automatically when the app starts. To run them by hand after
`npm run build`: `npm run migrate` (apply) or `npm run migrate -- down`
(roll back the latest one).
