# VOJAĜO app-backend

Zweiter Container des Stacks — Web-App + `/api/*` selbstgehostet auf Node, als Ergänzung zum
`ingest`-Container ([`tracker-backend/`](../tracker-backend)). Beide
zusammen bilden den Zwei-Container-Stack, der `docker-compose.yml` am
Repo-Root definiert.

Das ist der Betriebsweg; der frühere Cloudflare-Betrieb (Pages/D1/R2) wird
nicht mehr gebraucht.

## Warum das funktioniert, ohne `api/router.js` anzufassen

`api/router.js`/`api/lib.js` sind bereits im selben Fetch-API-Stil
geschrieben wie der Rest dieses Projekts: kein Framework, `handle(request,
env) → Response`. Die einzigen wirklich Cloudflare-spezifischen Bindings
sind `env.DB` (D1) und `env.PHOTOS` (R2) — beide werden nur über eine kleine,
klar umrissene Methodenmenge angesprochen (`.prepare().bind().all()/.run()`
bzw. `.get()/.put()/.delete()`). Diese Datei importiert `handle` direkt aus
[`../api/router.js`](../api/router.js) — **dieselbe Quelle**, die auch
`functions/api/[[path]].js` für den Cloudflare-Betrieb verwendet — und
reicht ihr `env.DB`/`env.PHOTOS` als Shims durch:

- [`src/d1-shim.js`](src/d1-shim.js) — persistente Variante von
  [`api/test/helpers/d1-memory.js`](../api/test/helpers/d1-memory.js) (dort:
  `node:sqlite` + `:memory:`, nur für Tests). Dieselbe Fassade, hier
  `better-sqlite3` auf einer echten Datei.
- [`src/r2-shim.js`](src/r2-shim.js) — `.get()/.put()/.delete()` auf dem
  lokalen Dateisystem. Content-Type wird aus der Dateiendung im Schlüssel
  abgeleitet (kein separates Metadatenformat nötig).
- [`src/static.js`](src/static.js) — liefert [`public/`](../public) (die
  gebaute PWA) aus, mit SPA-Fallback auf `index.html` für Client-Routen ohne
  Dateiendung (z. B. `/share/:token`, siehe `src/main.js`).
- [`src/server.js`](src/server.js) — Node↔Fetch-Adapter (gleiches Muster wie
  `tracker-backend/src/server.js`), routet `/api/*` an `router.js`, alles
  andere an die statische Auslieferung.

## Stand der Dinge

Alles fertig und real geprüft: Auth, Reisen, Orte, Notizen, Fotos,
Kategorien, Fahrzeuge (inkl. geräteübergreifender Synchronisierung),
Benutzerverwaltung — und die Positions-/Fahrten-/Stopp-Routen
(`/api/positions`, `/api/route`, `/api/stops`, `/api/drives`,
`/api/devices`) laufen komplett lokal über `positionsQuelle()` in
`api/router.js` (kein externer Positionsdienst beteiligt).
`LOCAL_POSITIONS=1` in `src/server.js` schaltet das um.

## Lokal starten

Voraussetzung: Node 22+, `npm install` in `app-backend/` UND einmal `npm run
build` im Repo-Root (baut `public/`).

```bash
cd app-backend
npm install
npm run dev
```

Health-Check: `curl http://localhost:8080/api/auth/me`

## Umgebungsvariablen

| Variable | Bedeutung | Vorgabe |
|---|---|---|
| `APP_HTTP_PORT` | Port für Web-App + API | `8080` |
| `APP_DB_PATH` | Pfad zur (mit `ingest` geteilten) SQLite-Datei | `data/vojago.db` |
| `APP_PHOTOS_PATH` | Basisverzeichnis für Fotos (R2-Shim) | `data/fotos` |
| `APP_PUBLIC_PATH` | Verzeichnis der gebauten PWA | `../public` |
| `APP_SCHEMA_PATH` | Pfad zu `db/schema.sql` (Override für abweichende Verzeichnistiefen) | `../../db/schema.sql` relativ zu `src/` |
| `APP_URL` | Öffentliche Basisadresse für Passwort-Reset-/E-Mail-Bestätigungslinks. Im Docker-Stack auf `https://vojago.example.com` vorbelegt, lokal sonst Anfrage-Ursprung. | — |
| `ALLOWED_ORIGINS`, `RESEND_API_KEY`, `MAIL_FROM` | wie beim Cloudflare-Betrieb, siehe Kopfkommentar in `api/router.js` | — |

## Docker

Siehe [`docker-compose.yml`](../docker-compose.yml) am Repo-Root — dieser
Container wird nicht allein gebaut/gestartet, sondern zusammen mit `ingest`
im selben Stack (gemeinsames Volume für die SQLite-Datei).

```bash
docker compose up -d --build
```
