# Working principles

How VOJAĜO is meant to look, feel and be changed. Read this before changing the
app, so UX, data, tests, documentation and deployment stay in step.

## Stance

VOJAĜO is a calm, reliable camper logbook, not a generic tracker and not a demo.
Map, trips, drives, places, overnight stays and the diary belong together, but
must not burden the user with layers and special paths.

- Changes respect the existing interaction concept.
- Every visible control works. No placeholders, no silent stopgaps.
- Done means: UI, storage, tests, documentation, GitHub and the live deploy are
  finished together.
- Decisions about the data model and rules go into [`concept.md`](concept.md);
  decisions about UX and ways of working go here.

## Navigation

The main navigation is, in this order: **Map, Trips, Logbook, More**. Do not
change the order by accident.

The current trip is the central object. Map, Trips and Logbook show the same
trip selector at the same place; tapping it opens the trip list including
"start a new trip".

Do not reintroduce:

- screen headings that repeat the active tab,
- several competing ways to do the same thing,
- buttons that look like main actions but are secondary.

## Design

Reduced, readable and calm:

- light background, or a dark theme with clear surfaces,
- orange as the active accent, muted green and grey for context,
- large touch targets, consistent segment controls.

Buttons and switches:

- Segment controls on Trips and Logbook match in position, height and effect.
- Extra actions (filter, plus) sit to the right of the segment control.
- Filter and plus open as a menu from the bottom, not as inline rebuilds.
- Active is orange; inactive stays quiet. Secondary actions ("show on map",
  "end trip", "delete trip") are less prominent than the main navigation.

Text:

- No text smaller than the readable size used in *Trips → Days*.
- Dates are compact and numeric (`10.08.26`), no long month names or
  four-digit years — they cost space on a phone.

Avoid marketing-page looks, large decorative cards, new colour logic without a
reason, and small hard-to-read meta text for important information.

## Map

Colourings: trip day (default), speed, elevation, distance. The legend for trip
days shows compact numbers (`1 2 4`). Layers (overnight stays, places, notes,
km markers) are remembered; the metric menu and the layer menu are never open
at the same time.

The drive filter (stages, supply drives, all) applies to the map, the totals,
the day list and the drive list. When a single drive or day is shown, there is
always a simple way back to the whole trip, labelled "Zurück".

## Trips, days and drives

- Trip: a named time span. Day: a calendar day within it. Drive: one movement
  from the drive report. Stage / supply drive: the kind of a drive.
- The trip view has Total, Days and Drives. Drives are grouped by day; an
  expanded day stays expanded when going back.
- Detail views show their statistics without repeating the whole list below,
  and always have a clear way back.
- Changing the kind of a drive applies at once, is stored centrally and is
  visibly reverted on errors.
- Days without a route do not appear as day cards.

## Logbook

The logbook is the told, chronological view of a trip:

- one chapter per day, with the diary entry first once it is written; route,
  overnight stay and places follow as collapsible cards,
- on wide screens the days flow into columns, on phones they stack,
- filters (overnight stays, places, notes) are real toggles,
- automatic, continued overnight stays are shown as a light display entry
  without a time.

## Overnight stays

Automatic overnight stays are long night stops, not date changes. The rule is
in `src/overnight-rules.js` and described in [`concept.md`](concept.md): at
least 5 hours standing, at least 2 of them inside 22:00–06:00. Several nights
at the same spot appear as several logbook events but count as one place in
the statistics. Driving through the night creates no overnight stay.

## Performance and data flow

When the app stutters, understand before changing:

- Which view renders? Which data is loaded?
- Is invisible content rebuilt? Is the map refitted although only data grew?
- Is an event not passed on to the map or a list?

Existing decisions:

- The route is sent thinned and compact (`thinPositions` in `api/lib.js`);
  the stored positions are never changed.
- Routes are kept on the device (IndexedDB, `src/route-store.js`) so the map and
  values appear right at start; a finished trip is only checked against the
  server, not downloaded again.
- Trip and day values are computed once and kept until the data changes
  (`src/memo.js`).
- Changing a drive's kind emits a `drives` event, so lists and map stay
  consistent.
- The live track grows in the background without refitting the map.

Data kept on the device (snapshot, routes) is useful for a fast start but is
personal data. "Delete local data" and logging out remove it; document any
change to what is kept.

## Tests, GitHub, deploy

Before calling something finished:

1. `npm test` (plus `npm --prefix app-backend test` and
   `npm --prefix tracker-backend test` when those changed)
2. `npm run build`
3. `npm run test:smoke` (runs in CI; needs the Playwright browser locally)
4. check the change in the browser, at phone width as well
5. update [`concept.md`](concept.md), this file or the README when behaviour
   or open points change
6. commit with a clear message, push, open a pull request, wait for green CI
7. deploy only on an explicit go-ahead, then check production

If a check cannot run (sandbox, port, network), do not ignore it: run it with
the right permissions or state clearly why it did not run.

Never report as finished when the UI changed but storage is missing, when
tests did not run, or when the state is not committed and pushed although it
should go live.

Schema changes go through a new migration in `db/migrate.js`, never through
code that alters tables on requests. Take a backup before deploying a release
with a new migration.
