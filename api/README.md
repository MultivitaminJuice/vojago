# VOJAĜO API

`router.js` is a Fetch-API router (no web framework) that implements the REST
API under `/api/*`; `lib.js` holds the testable building blocks (validation,
auth helpers, drive/stop segmentation, geocoding/weather helpers). The same
code runs in the self-hosted `app` container (`app-backend/`, through thin
D1/R2 shims on SQLite and the file system) and, historically, as a Cloudflare
Pages Function.

Authentication is the app's own: password hashing, `HttpOnly`+`Secure`+
`SameSite` session cookie, login rate limiting. All private routes expect a
valid session; `/api/health` answers without login but shows details only when
logged in.

## Resources

| Area | Routes |
|---|---|
| Auth | `/api/auth/*` — session state, first-account setup, login, logout, password, e-mail verification and reset |
| Positions | `/api/positions`, `/api/route`, `/api/stops`, `/api/drives`, `/api/devices` — read from the own `positions` table, drives/stops segmented on the server |
| Trips | `/api/trips`, `/api/drive-assignments`, `/api/shares` (read-only sharing links) |
| Places | `/api/orte`, `/api/besuche`, `/api/categories`, `/api/ignored-stops`, `/api/notes`, `/api/photos` |
| Vehicles & settings | `/api/vehicles`, `/api/settings`, `/api/ingest/*` (learning mode, known devices) |
| Guard | `/api/geofences`, `/api/alarms`, `/api/alarms/log`, `/api/push-*` |
| Helpers | `/api/geocode` (place names), `/api/weather` |
| Users | `/api/users` — admin only |

See `router.js` for the exact routes, parameters and validation.

## Variables

| Variable | Meaning |
|---|---|
| `ALLOWED_ORIGINS` | optional, only if the API is used from another origin |
| `DEBUG` | `true` returns error details to the caller (diagnostics only) |
| `LOCAL_POSITIONS` | set by the self-hosted container: positions/drives/stops come from the own `positions` table |
| `APP_URL` | public base address for password-reset / e-mail-verification links |
| `VAPID_PUBLIC_KEY` | public Web Push key handed to the browser |

## Database

The current full schema is `db/schema.sql` (used by both containers). The
single migrations in `api/migrations/` document later changes; `api/schema.sql`
is the Cloudflare D1 variant of the same tables.

## Run the checks

```bash
npm ci
npm test
npm run build
```

`npm test` covers logic and API integration: the integration tests load the
schema into an in-memory SQLite database and call the real router.
