# Glossary

One name per thing in navigation, page titles, buttons and messages (`NAV-8`).
Code, comments and docs use the English term; the UI uses the German term
(`ES-ADR-003`). Domain rules behind the terms are in [`concept.md`](concept.md).

| English (code, docs) | German (UI) | Meaning |
|---|---|---|
| Logbook | Logbuch | The continuous, automatic record. The user never presses "start". |
| Drive | Fahrt | One continuous movement, segmented on the server from positions (`segmentDrives` in `api/lib.js`). |
| Everyday drive | Alltagsfahrt | A drive that belongs to no trip. |
| Stop | Stopp | A stand of at least 20 minutes (see [`concept.md`](concept.md) § Stops and overnight stays). |
| Overnight stay | Übernachtung | A long night stand. *Nacht/Nächte* is used only as the unit when counting ("3 Nächte", "Nacht 2 von 3"), never as a name for the stay itself (decided 2026-11-27). |
| Place | Ort | A saved point with category, description, rating and photos. |
| Visit | Besuch | One stay at a place; a place can have many visits. |
| Trip | Reise | A named time span over the logbook; it bundles drives, stays and places inside it. |
| Guard | Wache | Anti-theft: armed at the vehicle's last reported position, alarms when it leaves the radius (see [`concept.md`](concept.md) § Guard). |
| Map | Karte | The full-screen map view. |
| Note | Notiz | A free note on the map or in the logbook. |
| Diary | Tagebuch | The written story of a day ("Tag erzählen"). |

## Open points

- Stored values and table names are still German (`orte`, `besuche`, `uebernachtung`,
  `stopp`, …). Whether they are migrated is not decided yet.
