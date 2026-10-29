# Concept and data model

## Roles

| Layer | Responsibility |
|---|---|
| **RUTX50 router** (or any OsmAnd-compatible device) | Capture GPS and send it to the `ingest` service (Teltonika AVL over TCP, or OsmAnd over HTTP) |
| **ingest** (`tracker-backend/`) | Store raw packets and positions, evaluate the guard on every new position, detect stops and overnight stays |
| **app** (`app-backend/` + `api/`) | Web app and REST API: trips, places, notes, photos, categories, vehicles, users, sharing |
| **SQLite (WAL)** | One shared file for both containers |
| **PWA** (`src/`) | Presentation and operation |

Raw data first: incoming packets go to `raw_packets` (short-lived, for
debugging), normalised points to `positions` (permanent). Drives, stops and
overnight stays are *derived* from positions and can be rebuilt at any time.
The server acknowledges a Teltonika packet only after it is stored, and
discards exact duplicates (same device and fix time) that a device re-sends.

## Terms

- **Logbook** — the continuous, automatic record. The user never presses "start".
- **Drive** — one continuous movement, segmented on the server from positions
  (`segmentDrives` in `api/lib.js`).
- **Stop / overnight stay** — a stand. A stand of at least 20 minutes is a
  *stop*; a long night stand is an *overnight stay* (see below).
- **Place** — a saved point with category, description, rating and photos.
  A **visit** is one stay at a place (a place can have many visits).
- **Trip** — a named time span over the logbook; it bundles drives, stays and
  places inside it.
- **Everyday drive** — a drive that belongs to no trip.

## Stops and overnight stays

The rules live in `src/overnight-rules.js` and are evaluated on the server
(`tracker-backend/src/auto-import.js`), for every vehicle, even when the app
is closed.

- **Overnight stay:** stand of at least **5 hours**, of which at least
  **2 hours** fall into the night window **22:00–06:00** (local time).
- **Stop:** any other stand of at least **20 minutes**.
- **Open stand:** while the vehicle stands, the router usually reports
  nothing. The server therefore extends the stand to "now" from the last known
  position and evaluates it with a timer set to the next threshold (stop,
  overnight, next midnight for the night count). Entries created this way are
  provisional; if later data contradicts them and nobody edited them, they are
  removed.
- **Reporting gaps:** a long gap with both ends at (almost) the same spot
  counts as standing.
- **Trips bound stays:** a stay counts only up to the end of its trip, and
  outside any trip (everyday life) no overnight stays are created; stops
  outside trips are kept.
- Several nights at the same place are separate visits but count as **one
  overnight place** while the coordinates are within about 300 m.

Examples: 23:00–04:00 → overnight. 21:00–01:00 → no overnight (only 4 hours).
10:00–16:00 → no overnight despite 6 hours (no night window). Driving through
the night → no stand, so no overnight.

## Drive time

"Driving time" is the sum of the time intervals in which the vehicle actually
moved. Normal reporting intervals (up to 2 minutes) count when an end point
moves at 5 km/h or more; a longer reporting gap counts only if the distance
covered in it matches a real drive (at least 10 km/h on average) — so a
tunnel counts, a parked vehicle with a silent router does not.

## Trip logic

- A trip is `[start, end]`; `end = null` means the **current trip**.
- Trips do not overlap; a drive belongs to at most one trip. Assignment is
  computed live from time, not stored.
- Created manually ("start trip") or from a suggestion. Everyday drives stay in
  the logbook and overall statistics but not in the trip list, and can be
  assigned to a trip afterwards.

## Route colouring

| Mode | Scale |
|---|---|
| Speed | blue → green → yellow → red |
| Elevation | green → tan → brown → summit white |
| Period | one colour per trip day |
| km from start | gradient 0 → total km |

## Routes driven more than once

When the same road is driven on several days (out and back), the lines would lie
exactly on top of each other and the latest drive would hide the others. The map
finds such stretches (`src/overlap.js`): two drives, separated by a pause of at
least 5 minutes, whose points are less than 45 m apart for at least 120 m. These
stretches are drawn again as a nested overlay, the earliest drive widest and each
later one narrower on top of it, in the colour of its day. The line never moves
off the road. The overlay is only drawn for the colourings where the colour
identifies the drive (trip day, trip); short touches such as a crossing or a
shared parking spot are ignored.

## Gaps in the recorded data

Sometimes the router records nothing for a while (a connection or service hang).
A gap is a pause of more than 40 s between two points that are more than 500 m
apart (`src/luecken.js`). The map would join them with a straight line as if that
stretch had been driven. With "mark data gaps" switched on (Settings → Appearance,
off by default) such a line gets dashed stripes, and tapping it shows the time,
duration and straight-line distance of the gap. Statistics and kilometres are
unchanged.

## Guard

Anti-theft, implemented in `tracker-backend/src/alarms.js`:

- **Arming** stores the vehicle's last reported position as the single anchor
  (fixed record `wache-aktuell` in `geofences`); the radius is configurable.
- **Debounce:** a change inside/outside counts only after two consecutive
  positions in the new state. After a few minutes of silence the state of the
  last position counts as confirmed (a return is reported even if the router
  stops reporting; "left" after silence only when clearly outside, more than
  1.5 × radius).
- Output: alarm log and Web Push. Arming and disarming are logged too.
- Implemented today: geofence only. Vibration, voltage and power-loss alarms
  need data the router does not report.

## Data model (excerpt)

```
trips(id, name, start_at, end_at?, vehicle_id?)          -- end_at NULL = current
orte(id, title, address, note, category_id, rating, lat, lon)
besuche(id, ort_id, source, kind[auto|manual], occurred_at, nights,
        weather, stop_key)                                -- one stay at a place
ignored_stops(stop_key)                                   -- dismissed suggestions
drive_assignments(drive_key, trip_id, assignment, kind)
notes, photos, categories, vehicles, users, sessions, trip_shares
geofences, alarm_settings, alarm_log, push_subscriptions
raw_packets, positions
```

`besuche` has no `trip_id`: the trip is computed from `occurred_at` against the
trip time spans. The full schema is in `db/schema.sql`.
