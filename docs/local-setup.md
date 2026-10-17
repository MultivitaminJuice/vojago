# Working locally with real data — without publishing it

The repository is public. Your machine, however, deals with real data: real
GPS tracks, a real database, private notes, real host names. This setup lets
you work with all of it locally and makes it hard to push any of it by mistake.

## What lives where

| | In the repository (public) | Only on your machine (`local/`, git-ignored) |
|---|---|---|
| Code, docs, tests | yes | |
| Test data | anonymised (`api/test/fixtures/`) | real data (`local/fixtures/`) — tests use it automatically when present |
| Working diary, deploy notes with real hosts | no | `local/docs/` |
| Copy of a real database | no | `local/data/` |
| Your blocklist of sensitive terms | no | `local/denylist.txt` |
| Secrets (VAPID keys, tokens, map key) | never — environment variables / Portainer | |

## One-time setup per clone

```bash
npm ci
npm run setup-local
```

This activates the git hooks (`core.hooksPath = .githooks`) and creates `local/`
from `local.example/`. Then fill `local/denylist.txt` with your own sensitive
terms (home town, street, places you visit, device IDs, internal IPs, your
domain, e-mail) as regular expressions, one per line.

## The guard

Three git hooks run `scripts/check-sensitive.mjs`:

- **pre-commit** — scans the lines you are about to commit,
- **commit-msg** — scans the commit message,
- **pre-push** — scans every commit that would be pushed (including messages).

A hit aborts the commit/push and lists the file and line. Built-in patterns
(private keys, tokens) apply to everybody; your `local/denylist.txt` adds the
personal terms. `npm run check:sensitive` scans all tracked files at once.
`git commit --no-verify` bypasses the hooks — use it only for a false alarm.

On the GitHub side, secret scanning and push protection are enabled for the
repository as a second line of defence for credentials.

## Working with real test data

Put real data in `local/fixtures/` under the same file name as the committed
fixture. The tests then use the real data (set `FIXTURES=public` to force the
anonymised files, which is what CI does).

To add a new real data set to the public tests, anonymise it first:

```bash
npm run anonymize -- local/fixtures/new.json api/test/fixtures/new.json
```

This mirrors the latitude (`lat → -lat`) and shifts the longitude (`lon + 20`).
All distances and timings stay exactly the same (the haversine formula only
depends on the latitude through `cos` and on longitude *differences*), so the
tests check the same thing — the place just can no longer be recognised.

## Rules of thumb

- No real places, addresses, device IDs, private host names or e-mail addresses
  in code, comments, tests or commit messages. Write neutrally ("a stop on a
  country road").
- Secrets only as environment variables (`CARTO_API_KEY` at build time; VAPID
  keys etc. on the server), never in the repository.
- Private notes and anything with real hosts go to `local/docs/`.
