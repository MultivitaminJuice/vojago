# local/ — nur auf diesem Rechner

Dieser Ordner steht in `.gitignore`: **nichts daraus wird je zu GitHub hochgeladen.**
Hier liegt, was echt und privat ist:

| Pfad | Inhalt |
|---|---|
| `denylist.txt` | deine Sperrliste (reguläre Ausdrücke); die Git-Hooks lehnen Commit/Push ab, wenn eine Zeile trifft |
| `fixtures/` | echte Positionsdaten für die Tests (gleicher Dateiname wie in `api/test/fixtures/`); wenn vorhanden, nehmen die Tests diese statt der anonymisierten |
| `docs/` | privates Arbeitstagebuch, Deploy-Notizen mit echten Hosts |
| `data/` | Kopie einer echten Datenbank zum lokalen Ausprobieren |

Echte Daten in die Tests aufnehmen und trotzdem veröffentlichen:

```bash
npm run anonymize -- local/fixtures/neu.json api/test/fixtures/neu.json
```

Das spiegelt den Breitengrad und verschiebt den Längengrad; Abstände und Zeitabläufe bleiben
exakt gleich. Nur die anonymisierte Datei kommt ins Repository.
