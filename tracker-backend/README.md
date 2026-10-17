# VOJAĜO tracker backend (`ingest`)

GPS receiving service — the `ingest` container of the two-container stack. It
runs together with [`app-backend/`](../app-backend) via
[`docker-compose.yml`](../docker-compose.yml) at the repository root and shares
one SQLite file with it.

It stores raw packets and positions, evaluates the guard on every new
position, and detects stops and overnight stays for every vehicle. See
[`docs/concept.md`](../docs/concept.md) for the rules.

## Protocols

- **OsmAnd** (HTTP, port 5055 in the container) — verified with real devices,
  including a burst of buffered points delivered after a connection gap, each
  stored with its original fix time (not the arrival time). Clients that send
  no `speed` / `course` / `sat` / `ignition` / `motion` are fine; the
  knots → km/h conversion is only confirmed for devices that send speed.
- **Teltonika Codec 8 / 8E** (TCP, port 5027 in the container; see
  [`src/protocols/teltonika-codec.js`](src/protocols/teltonika-codec.js) for the
  byte format and [`src/protocols/teltonika.js`](src/protocols/teltonika.js) for
  the TCP framing) — verified with a real RUTX50 (Codec 8). Supported: IMEI
  handshake with accept/reject, Codec 8 and 8E, any number of AVL records per
  packet (including buffered bursts), CRC-16 check, acknowledgement of the
  accepted record count after storage. On any structural error (bad checksum,
  broken preamble, inconsistent record count) the connection is closed cleanly
  instead of guessing; the device reconnects on its own. Ignition/movement IO
  elements (239/240) are covered by round-trip tests only.
  Written from the openly documented Teltonika AVL protocol, with the open-source
  Traccar decoder as a reference for understanding the protocol (no code taken).

## Why Node

Node with `better-sqlite3` instead of Bun: Bun needs AVX instructions, which
the home server's CPU lacks. A small adapter between Node `http` and the web
standard `Request`/`Response` API lives in `server.js`; the routing/handler
logic (`osmand.js`) builds only on web standards.

## Run locally

Requirement: Node 22+.

```bash
cd tracker-backend
npm install
npm run dev
```

Health check: `curl http://localhost:5055/health`

Send a test point (as OsmAnd or a logger would):

```bash
curl "http://localhost:5055/?id=test1&lat=52.1&lon=7.3&timestamp=$(date +%s)&speed=10"
```

Unknown device IDs are rejected unless the device is registered as a vehicle in
the app, listed in `TRACKER_ALLOWED_DEVICE_IDS`, or the short learning mode is
active.

To test a Teltonika router, add a second "Data to Server" target in RutOS
(Codec 8, port 5028 on the host, see the compose file) pointing at the server.

## Data

- `raw_packets` — the packets as received, short-lived (default 30 days,
  `TRACKER_RAW_RETENTION_DAYS`). For debugging only.
- `positions` — parsed and normalised, permanent. Deliberately narrow: only
  fields the app uses. Re-sent duplicates (same device and fix time) are
  dropped.

## Environment variables

| Variable | Meaning | Default |
|---|---|---|
| `TRACKER_DB_PATH` | Path to the SQLite file | `data/tracker.db` |
| `TRACKER_HTTP_PORT` | OsmAnd/HTTP port | `5055` |
| `TRACKER_TCP_PORT` | Teltonika/TCP port | `5027` |
| `TRACKER_ALLOWED_DEVICE_IDS` | Optional extra allow-list of OsmAnd IDs and Teltonika IMEIs. Empty: only vehicles registered in the app or the short learning mode are accepted. | empty |
| `TRACKER_RAW_RETENTION_DAYS` | Raw packet retention in days | `30` |
| `TRACKER_LOG_RAW_TELTONIKA` | `1` = log every incoming raw byte as hex (for the first test against real hardware) | off |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push key pair for guard notifications (see `src/push.js`) — generate once with `npx web-push generate-vapid-keys` and keep it (a new pair invalidates all subscriptions) | none — push stays off, no error |
| `VAPID_SUBJECT` | Contact address for the push protocol (`mailto:...` or `https://...`) | `mailto:admin@example.com` |
| `TZ` | Time zone for the night window (set in the Dockerfile) | `Europe/Berlin` |

## Docker

This directory is not built on its own any more — see
[`docker-compose.yml`](../docker-compose.yml) at the repository root (two
containers, `app` + `ingest`; this directory provides `ingest`).
