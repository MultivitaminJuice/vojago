# local/ — only on this machine

This folder is listed in `.gitignore`: **nothing in it is ever pushed to
GitHub.** It holds what is real and private:

| Path | Content |
|---|---|
| `denylist.txt` | your blocklist (regular expressions); the git hooks reject a commit or push when a line matches |
| `fixtures/` | real position data for the tests (same file name as in `api/test/fixtures/`); when present, the tests use it instead of the anonymised data |
| `docs/` | private working notes, deploy notes with real hosts |
| `data/` | a copy of a real database for trying things locally |

To add real data to the tests and still publish them:

```bash
npm run anonymize -- local/fixtures/new.json api/test/fixtures/new.json
```

This mirrors the latitude and shifts the longitude; distances and timings stay
exactly the same. Only the anonymised file goes into the repository.
