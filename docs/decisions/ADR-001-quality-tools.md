# ADR-001: Quality tools – Biome and `tsc --checkJs`

| Field | Value |
|---|---|
| ID | ADR-001 |
| Title | Quality tools – Biome and `tsc --checkJs` |
| Status | Proposed |
| Date | 2026-11-27 (created) · accepted: – |
| Approval | open |
| Supersedes | – |
| Superseded by | – |
| Related | `MNT-1`, `TYP-1`, `TYP-2`, `TST-5`, `LL-005`, ES-ADR-006, ES-ADR-007, ES-ADR-011 |

## Context

The project had no formatter, linter or type checker. A renamed string constant broke the
UI without any test noticing (renaming `"nacht"/"stopp"` to `"night"/"stop"` in
`journal-days.js` while `journal.js` still compared against the old strings).

Measured on 2026-11-27 before any fix:

- Biome lint (recommended rules): 18 errors, 28 warnings, 38 infos in 123 files.
- Biome format at 100 characters: 107 files would change.
- `tsc --checkJs` on `src/` and `api/` without tests: 77 errors non-strict, 2,280 strict
  (mostly implicit `any` from missing JSDoc).

## Problem

Which formatter, linter and type checker does the project use, and how are they introduced
into ~16,000 lines of existing JavaScript?

## Decision

1. **Biome** (`@biomejs/biome`, dev dependency) is the formatter and linter. Config in
   `biome.json`: 2 spaces, double quotes, semicolons, line width 100, `recommended` rules.
   JavaScript files only (`*.js`, `*.mjs`); generated `src/demo-roads.js` and test fixtures
   are excluded. CSS is not formatted yet.
2. **TypeScript** (`typescript`, dev dependency) checks JavaScript with JSDoc:
   `tsc -p .` with `checkJs: true`, `strict: false`, `noEmit: true` (`tsconfig.json`).
   Scope: `src/` and `api/` without tests.
3. All existing lint findings are fixed (errors and warnings by hand, infos by Biome's safe
   fixes); the linter has no findings afterwards. All type findings are fixed.
4. The first formatting run is a commit of its own, without other changes.
5. `npm run check` runs format check, lint and type check; it runs locally and in CI.

## Alternatives considered

1. **ESLint + Prettier** – more rules, but several packages and two configurations
   (ES-ADR-011).
2. **File by file with `// @ts-check` and `strict`** (as described in ES-ADR-007) – most files
   would stay unchecked for a long time; the strict findings are mostly missing annotations,
   not bugs.
3. **Line width 120** – fewer changed lines, but longer lines in diffs and split editors.

## Reasoning

Biome is one package for both formatting and linting. Checking all files non-strict finds
real errors everywhere at once with 77 findings to fix, instead of leaving most of the code
unchecked.

**Deviation from ES-ADR-007:** ES-ADR-007 introduces the check file by file with
`// @ts-check`. This project checks all files at once, but without `strict`. The goal of
ES-ADR-007 (type checking for existing JavaScript without moving to `.ts`) is kept; the
stricter check (`noImplicitAny`) follows later file by file.

## Positive consequences

- Wrong literals, wrong argument counts and unknown properties are found before commit.
- One command (`npm run check`) for all checks, the same locally and in CI.

## Negative consequences

- A large formatting commit; `git blame` needs `--ignore-rev` for it.
- Non-strict checking misses errors in values typed as `any`.

## Risks

- Formatting mixed with behaviour changes – the formatting commit contains nothing else.
- `strict` never comes – the backlog keeps "enable `noImplicitAny` per file" as an item.

## Scope

`src/` and `api/`. Not yet covered: `app-backend/`, `tracker-backend/`, `scripts/`, the tests
(they need Node type declarations, a further dev dependency) and the CSS.

## Possible exceptions

Generated files and vendored code are excluded in the config. A single suppression needs a
`biome-ignore` or `@ts-expect-error` comment with the reason (coding standards 0.3).
