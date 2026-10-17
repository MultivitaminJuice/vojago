# Backup & Restore

Ein tatsächlich einmal
durchgespielter Weg zurück, nicht nur eine theoretische Datenbankstruktur.

## D1 (Reisen, Orte, Notizen, Fotos-Metadaten, Konten, …) — getestet ✅

**16. August 2026 einmal real durchgeführt:** Export der Produktivdatenbank,
Import in eine frische Test-Datenbank, alle 17 Tabellen per Zeilenzahl
verglichen (Treffer) und eine Reise (`trips`) inhaltlich Feld für Feld
verglichen (Treffer). Test-Datenbank und lokale Exportdatei danach wieder
gelöscht — dieses Dokument ist der bleibende Nachweis, keine Kopie der Daten.

### Backup erstellen

```bash
npx wrangler d1 export vojago --remote --output=vojago-backup.sql
```

**Achtung:** Wrangler weist selbst darauf hin, dass die Datenbank während des
Exports kurz keine Anfragen bedienen kann — am besten zu einer Zeit
durchführen, in der gerade niemand unterwegs ist bzw. die App aktiv nutzt.
Bei der aktuellen Datenmenge (~15 KB Exportgröße, Stand 16. August 2026) war
das im Test in Sekunden durch.

Die erzeugte `.sql`-Datei enthält **alle** Klartextinhalte inklusive
Passwort-Hashes und Sitzungs-Hashes (nicht die Klartext-Passwörter selbst,
aber trotzdem sensibel) — nicht unverschlüsselt liegen lassen oder ins Repo
committen. Nach jedem Test/Restore wieder löschen, ein „echtes" Backup gehört
an einen selbst gewählten, sicheren Ort außerhalb dieses Rechners.

### Restore prüfen (in eine Wegwerf-Datenbank, nicht in die echte!)

```bash
npx wrangler d1 create vojago-restore-test
npx wrangler d1 execute vojago-restore-test --remote --file=vojago-backup.sql

# Stichprobe je Tabelle, z. B.:
npx wrangler d1 execute vojago-restore-test --remote \
  --command "SELECT COUNT(*) FROM trips"

# Aufräumen:
npx wrangler d1 delete vojago-restore-test
rm vojago-backup.sql
```

**In eine echte Wiederherstellung** (Produktivdatenbank tatsächlich
überschreiben) würde man `vojago-backup.sql` stattdessen gegen die echte
`vojago`-Datenbank ausführen — das war hier bewusst **nicht** Teil des Tests,
das bleibt ein Schritt mit echtem Risiko, kein Automatismus.

## R2 (Foto-Dateien) — **noch nicht abgedeckt** ⚠️

Der D1-Export sichert nur die **Metadaten** eines Fotos (`photos`-Tabelle:
wer, wann, wo, `r2_key`) — nicht die eigentliche Bilddatei im Bucket
`vojago-fotos`. Ein D1-Restore ohne begleitendes R2-Backup hätte
„Foto-Datensätze, die auf nichts mehr zeigen" zur Folge.

**Noch offen:** R2 hat kein eingebautes Snapshot/Restore wie D1. Optionen für
später: `rclone` gegen den S3-kompatiblen R2-Endpunkt spiegeln, oder R2
Object Lifecycle/Versionierung aktivieren. Bisher nur eine Handvoll Fotos im
Bestand (Stand 16. August 2026) — Dringlichkeit steigt mit der Foto-Menge.

## Self-hosted stack (SQLite volume)

Both containers share one SQLite file (WAL mode) in the Docker volume
`vojago-data` (`/data/vojago.db`), photos live next to it. Back up with a
consistent snapshot rather than copying the live file:

```bash
docker exec vojago-ingest node -e "import('/app/tracker-backend/src/store.js').then(async ({db}) => { await db.backup('/data/vojago.db.bak-' + Date.now()); process.exit(0); })"
```

and copy the volume (database snapshot plus `fotos/`) to another machine, e.g.
`docker run --rm -v vojago-data:/data -v $PWD:/backup alpine tar czf /backup/vojago-data.tar.gz /data`.
Restore by extracting into an empty volume and starting the stack.
