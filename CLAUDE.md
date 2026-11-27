# CLAUDE.md – VOJAĜO (camper-tracker)

Standards: the owner's central engineering standards (private; their location is set in
the owner's global Claude settings), below `ES/`. Read its `claude/CLAUDE.md` first. Cite rules by ID (`ERR-1`, `UI-2`, `TOK-COL-3`), central ADRs as `ES-ADR-NNN`,
lessons as `LL-NNN`. This file only lists what is specific to this project; it does not
repeat the standards (`MNT-5`).

Project type: PWA, phone first (`ES/ux-ui/design-principles.md` § 5, row VOJ): all UX rules
apply, plus the full-screen page type for the map.

Project docs: `README.md` (architecture, running locally), `docs/working-principles.md`
(navigation, design, done criteria), `docs/concept.md` (domain model, rules, schema),
`docs/backup-restore.md`, `docs/local-setup.md` (privacy guard).

## Commands

| Purpose | Command | Status |
|---|---|---|
| Install | `npm ci` · `npm --prefix app-backend ci` · `npm --prefix tracker-backend ci` | from CI (`.github/workflows/ci.yml`), not run locally |
| One-time setup per clone | `npm run setup-local` (activates `.githooks`, creates `local/` from `local.example/`) | `core.hooksPath` = `.githooks` verified |
| Unit + integration tests | `npm test` (`api/test`, `src/test`) | verified 2026-11-27: 239/239 |
| Backend tests | `npm --prefix app-backend test` · `npm --prefix tracker-backend test` | verified 2026-11-27: 9/9, 63/63 |
| Build PWA | `npm run build` → `public/` (`scripts/build-site.mjs`; map key via `CARTO_API_KEY` env) | verified 2026-11-27 (exit 0, two CSS warnings at `src/styles.css:802`) |
| Smoke tests | `npm run test:smoke` (build + Playwright, `smoke/`, static server on port 4173); `smoke/areas.smoke.test.js` checks every tab and runs axe | verified 2026-11-27: 8/8 (needs `npx playwright install chromium` once per machine) |
| Dev server | `npm run dev` → http://127.0.0.1:4173 (also `.claude/launch.json`, config `vojago`) | not run |
| Privacy scan | `npm run check:sensitive` (also runs in the git hooks) | not run |
| Format, lint, type check | `npm run check` (all three, also in CI) · `npm run format` (write) · `npm run lint` · `npm run typecheck` — Biome and `tsc --checkJs`, see ADR-001 | verified 2026-11-27: no findings |
| Deploy | `docker compose up -d --build` with `docker-compose.yml` (README § Architecture), only on the user's explicit go-ahead | not verified; host-specific notes live in `local/` and are not read |

Before "done": `docs/working-principles.md` § Tests, GitHub, deploy, plus
`ES/global/coding-standards.md` part 15 and, for UI work, `ES/ux-ui/ux-checklist.md`.

## Structure

| Path | Content |
|---|---|
| `src/` | Frontend (vanilla JS ES modules, no framework). `main.js` wiring, `state.js` central state + events, `store.js` optimistic saves with rollback, `dom.js` `el()` helper and `toast()`, pure domain modules (`gaps.js`, `overlap.js`, `route-*.js`, …) |
| `src/views/` | One module per view or editor (`trips.js`, `journal.js`, `settings.js`, `guard.js`, `*-editor.js`) |
| `src/ui/` | Shared UI building blocks (`dirty-guard.js`, `sheets.js`, `calendar.js`, `inline-edit.js`, photo components) |
| `src/shell.html`, `src/styles.css` | App shell markup and the one stylesheet with the design tokens |
| `src/test/` | Tests of the frontend domain modules |
| `api/` | Shared API: `router.js` (fetch-style `handle(request, env)`), `lib.js` (validation, helpers, domain algorithms), `test/` |
| `app-backend/` | Node container: HTTP server, static files, D1/R2 shims, backup download |
| `tracker-backend/` | Node container: GPS ingest (Teltonika TCP, OsmAnd HTTP), guard alarms, push |
| `db/` | `schema.sql` (one schema) and `migrate.js` (numbered migrations, `PRAGMA user_version`) |
| `scripts/` | Build, build info, privacy guard, fixture anonymizer, local setup |
| `smoke/` | Playwright smoke tests and `static-server.mjs` |
| `docs/` | Project documentation (see above) |
| `local/` | Git-ignored private data, real fixtures, deploy notes, denylist — never read or commit |

## Decisions and glossary

- Project ADRs: `docs/decisions/` (index in its `README.md`; none yet). Central ADRs:
  `ES/decisions/`, cited as `ES-ADR-NNN`. Template: `ES/templates/adr-template.md`.
- Glossary: `docs/glossary.md` (`NAV-8`) — the one list of domain terms, with the English
  code term and the German UI term.

## Pages, shell and navigation

- App shell: `src/shell.html` — header, tab bar `nav.tabbar` (line ~610), toast `#toast`,
  status line `#app-status`; tab switching in `go()` in `src/main.js`, view registry
  `views` in `src/main.js` (line ~93). Toasts via `toast()` in `src/dom.js`.
- Central navigation definition (`UI-2`): **none yet** — tabs are written in
  `src/shell.html` and mirrored in `views`. Main order is fixed: Karte, Reisen, Logbuch,
  Mehr (`docs/working-principles.md` § Navigation); "Mehr" holds Wache, Status,
  Einstellungen (`data-more-panel`).
- Operating concept: `docs/working-principles.md` § Navigation and § Design, and `ES/ux-ui/`.

| Page type (`NAV-7`) | Pages | Template (`UI-3`) | Reference page |
|---|---|---|---|
| Full screen | Karte (`#view-map`, `src/mapview.js`) | none yet | Karte |
| List | Reisen (`#view-reise`, `src/views/trips.js`) | none yet | Reisen *(proposal)* |
| Editor | Ort, Notiz, Tagebuch (`src/views/*-editor.js`, guarded by `src/ui/dirty-guard.js`) | none yet | Ort-Editor *(proposal)* |
| Settings | Mehr → Einstellungen (`src/views/settings.js`) | none yet | Einstellungen |
| Detail, Overview | not assigned yet | – | – |
| *open* | Logbuch (chapter layout per day, `src/views/journal.js`) | – | type not decided; a new type needs a project ADR |

## Exceptions to the standards

| Rule | Exception | Source |
|---|---|---|
| `TOK-COL-3` [C] | Project accent `#ae5913` with white text (`#ffffff`), the same in light and dark theme; accent only as a fill, never as text; links in text colour with underline. | `ES/ux-ui/design-tokens.md` TOK-COL-3, fixed 2026-11-27 |
| `NAM-1` | UI texts are German; code, comments, docs and commits are English. *(This is the rule itself, listed for clarity.)* | `docs/working-principles.md`, `ES/global/coding-standards.md` |

Proposed, not yet accepted: ADR-001 checks all files with `tsc --checkJs` at once but without
`strict`, instead of file by file as in ES-ADR-007.

No other exception is decided. Open point that needs a decision by the user before it
becomes an exception: stored German enum values and table names.

## Never

- Read, print or commit anything from `local/` or `.env*`; bypass the privacy hooks with
  `--no-verify` except for a confirmed false alarm.
- Touch the production server or database, or deploy, without the user's explicit go-ahead.
- Change the schema outside a new migration in `db/migrate.js`, or deploy a migration
  without a backup first.
- Rename a stored value (enum strings, table or column names) without a data migration,
  or rename a value constant without searching for the old string (`TYP-2`, `DAT-2`, `LL-005`).
- Insert user text via `innerHTML` (`src/dom.js`).
- Change the order of the main tabs, add a heading that repeats the active tab, or build
  page-local navigation (`UI-1`).
- Add a dependency without the user's approval (`MNT-8`).
