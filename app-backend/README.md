# VOJAĜO app-backend

The `app` container of the stack: the web app plus `/api/*`, self-hosted on
Node. Together with the `ingest` container ([`tracker-backend/`](../tracker-backend))
it forms the two-container stack defined by `docker-compose.yml` at the
repository root.

## How it fits together

`api/router.js` and `api/lib.js` are written in plain Fetch-API style: no
framework, `handle(request, env) → Response`. This container imports `handle`
from [`../api/router.js`](../api/router.js) and hands it an `env` with:

- `DB` — [`src/d1-shim.js`](src/d1-shim.js): `better-sqlite3` on the shared
  SQLite file, exposing the small `prepare().bind().all()/.run()` interface the
  router uses. On open it runs `db/schema.sql` and the migrations in
  `db/migrate.js`. The in-memory twin for tests is
  [`api/test/helpers/d1-memory.js`](../api/test/helpers/d1-memory.js).
- `PHOTOS` — [`src/r2-shim.js`](src/r2-shim.js): `.get()/.put()/.delete()` on
  the local file system. The content type comes from the file extension.
- `BACKUP` — [`src/backup.js`](src/backup.js): builds the backup download
  (database copy, photos, manifest as `.tar.gz`, see
  [`docs/backup-restore.md`](../docs/backup-restore.md)).

[`src/static.js`](src/static.js) serves [`public/`](../public) (the built PWA)
with an `index.html` fallback for client routes without a file extension
(e.g. `/share/:token`). [`src/server.js`](src/server.js) adapts Node's HTTP
server to the Fetch API and routes `/api/*` to the router, everything else to
the static files.

## Run locally

Requires Node 22+ and a built front end (`npm run build` at the repository
root, which creates `public/`).

```bash
cd app-backend
npm install
npm run dev
```

Health check: `curl http://localhost:8080/api/auth/me`

## Environment variables

| Variable | Meaning | Default |
|---|---|---|
| `APP_HTTP_PORT` | port for web app and API | `8080` |
| `APP_DB_PATH` | the SQLite file shared with `ingest` | `data/vojago.db` |
| `APP_PHOTOS_PATH` | directory for photo files | `data/fotos` |
| `APP_PUBLIC_PATH` | directory of the built PWA | `../public` |
| `APP_SCHEMA_PATH` | path to `db/schema.sql`, for other directory layouts | `../../db/schema.sql` relative to `src/` |
| `APP_URL` | public base address for password-reset and e-mail-verification links; without it the request origin is used | — |
| `ALLOWED_ORIGINS` | only if the API is called from another origin | — |
| `RESEND_API_KEY`, `MAIL_FROM` | sending mail through Resend; without a key no mail is sent | — |
| `VAPID_PUBLIC_KEY` | public Web Push key handed to the browser | — |

## Docker

This container is built and started together with `ingest`, sharing one volume
for the SQLite file and the photos. See
[`docker-compose.yml`](../docker-compose.yml):

```bash
docker compose up -d --build
```
