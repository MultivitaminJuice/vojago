# Backup and restore

Everything VOJAĜO knows lives in one Docker volume (`vojago-data`):

- `vojago.db` — the SQLite database shared by both containers: trips, places,
  visits, notes, the diary, accounts and sessions, guard settings, and every
  recorded position.
- `fotos/` — the photo files. The database only holds their metadata.

A backup needs both, taken at the same moment.

## Download a backup from the app

Admins find **Backup → Backup herunterladen** under *More → Status*. It
downloads one file, `vojago-backup-YYYY-MM-DD.tar.gz`, with:

| File | Content |
|---|---|
| `manifest.json` | format version, time of the backup, row counts of the main tables, number of photos |
| `vojago.db` | a consistent copy of the database (SQLite online backup, safe while the ingest keeps writing) |
| `fotos/…` | all photo files |

You decide where to keep it (another disk, a NAS, a cloud drive). The file is
sensitive: it holds every position, the diary, e-mail addresses, password
hashes and session hashes. Store it where only you can read it.

The download is built in memory on the server; with a few hundred thousand
positions it is around 10 MB and takes about a second.

## Restore

1. Unpack the archive somewhere on the server:

   ```bash
   mkdir restore && tar -xzf vojago-backup-YYYY-MM-DD.tar.gz -C restore
   cat restore/manifest.json
   ```

2. Stop both containers, so nothing writes to the database:

   ```bash
   docker compose stop app ingest
   ```

3. Put the database and photos into the volume. This replaces the current
   data; take a backup of the current state first if it might still be needed.

   ```bash
   docker run --rm -v vojago-data:/data -v "$PWD/restore":/restore alpine sh -c \
     'rm -f /data/vojago.db /data/vojago.db-wal /data/vojago.db-shm \
      && cp /restore/vojago.db /data/vojago.db \
      && rm -rf /data/fotos && cp -r /restore/fotos /data/fotos'
   ```

   Remove the `-wal` and `-shm` files together with the old database: they
   belong to it and must not be applied to the restored one.

4. Start the containers again:

   ```bash
   docker compose start ingest app
   ```

   On start, both containers bring the restored database up to the current
   schema version (see [Schema and migrations](concept.md#schema-and-migrations)),
   so a backup from an older release can be restored into a newer one.

## Restore drill

`app-backend/src/backup.test.js` runs a restore drill on every CI run: it
creates a database with a trip, a position and a photo, builds the backup,
unpacks it with the standard `tar` tool and checks rows and photo bytes. A
manual drill against real data (all 24 tables with identical row counts,
`PRAGMA integrity_check` ok) was done before the feature was released.

## Backup without the app

On the server, a consistent copy can also be taken directly:

```bash
docker exec vojago-ingest node -e "import('/app/tracker-backend/src/store.js').then(async ({db}) => { await db.backup('/data/vojago.db.bak-' + Date.now()); process.exit(0); })"
```

That copy stays in the same volume, so it protects against mistakes but not
against losing the disk. Copy it off the server, together with `fotos/`, for
example with
`docker run --rm -v vojago-data:/data -v $PWD:/backup alpine tar czf /backup/vojago-data.tar.gz /data`.
