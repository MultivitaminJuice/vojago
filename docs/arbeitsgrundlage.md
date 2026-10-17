# VOJAGO Arbeitsgrundlage fuer spaetere Aenderungen

Stand: 14. August 2026

Diese Datei beschreibt, was bei VOJAGO wichtig ist. Sie ist als Leitplanke fuer
spaetere KI- oder Entwickler-Arbeit gedacht, damit UX, Datenlogik, Tests,
Dokumentation und Deployment nicht wieder auseinanderlaufen.

## Grundhaltung

VOJAGO ist keine generische Tracker-App und keine Demo-Oberflaeche mehr. Die App
soll sich wie ein ruhiges, verlaessliches Camper-Logbuch anfuehlen: Karte,
Reisen, Fahrten, Orte, Uebernachtungen und Logbuch gehoeren zusammen, aber sie
duerfen den Nutzer nicht mit zu vielen Ebenen und Sonderwegen belasten.

Wichtig:

- Aenderungen muessen das bestehende Bedienkonzept respektieren.
- Sichtbare Bedienelemente muessen wirklich funktionieren.
- Fertig heisst: UI, Datenhaltung, Tests, Dokumentation, GitHub und Live-Deploy
  sind gemeinsam erledigt.
- Keine stillen Provisorien und keine neuen Attrappen.
- Konzeptentscheidungen werden in `docs/concept.md` oder hier dokumentiert.

## Navigations- und Screen-Konzept

Die Hauptnavigation bleibt:

1. Karte
2. Reisen
3. Logbuch
4. Mehr

Karte ist links, Reisen daneben, Logbuch danach, Mehr rechts. Diese Reihenfolge
ist bewusst gewaehlt und darf nicht versehentlich zurueckgedreht werden.

Die aktuelle Reise ist ein zentrales Objekt. Karte, Reisen und Logbuch zeigen
oben dieselbe Reise-Auswahl im gleichen Stil und an derselben Position. Ein
Klick darauf oeffnet die Reiseauswahl inklusive "Neue Reise starten".

Der App-Kopf zeigt den Namen:

- `VOJAGO - Explore & Track`
- Der Zusatz muss lesbar bleiben und mittig zum Namen wirken.
- Zwischen Kopf und Reiseauswahl soll kein unnoetiger Leerraum entstehen.

Nicht wieder einfuehren:

- separate, doppelte Screen-Ueberschriften wie "Reisen" oder "Logbuch", wenn
  der aktive Tab das bereits erklaert.
- mehrere konkurrierende Wege fuer dieselbe Aktion.
- Buttons, die wie Hauptaktionen aussehen, aber nur Nebenfunktionen sind.

## Gestaltung

Die UI soll reduziert, gut lesbar und ruhig sein. Der aktuelle Stil basiert auf:

- hellem Hintergrund bzw. dunklem Modus mit klaren Flaechen,
- Orange als aktive Akzentfarbe,
- gedeckten Gruen-/Grau-Toenen fuer Kontext und Ruhe,
- grossen, gut antippbaren Flaechen,
- konsistenten Segment-Controls.

Buttons und Schalter:

- Segment-Controls muessen zwischen Reisen und Logbuch in Position, Hoehe und
  Wirkung zusammenpassen.
- Zusatzaktionen wie Filter oder Plus sitzen rechts neben dem Segment-Control
  im gleichen Raster.
- Filter- und Plus-Aktionen oeffnen als Menue von unten, nicht als zufaellige
  Inline-Umbauten.
- Aktive Buttons sind orange; inaktive Buttons bleiben ruhig.
- Nebenaktionen wie "Auf Karte zeigen", "Reise beenden" oder "Reise loeschen"
  sind weniger dominant als die Hauptnavigation.

Schrift:

- Die App war mehrfach an der unteren Lesbarkeitsgrenze. Neue Texte duerfen
  nicht kleiner werden als die gut lesbare Groesse in `Reisen > Tage`.
- Datumsanzeigen sind kompakt numerisch: z. B. `10.08.26`, nicht
  `10. August 2026`.
- Lange Monatsnamen und vierstellige Jahre vermeiden, weil sie auf dem iPhone
  wichtigen Platz verbrauchen.

Nicht verwenden:

- Marketing-Landingpage-Optik.
- grosse dekorative Karten im Karten-/Reise-/Logbuch-Kontext.
- neue Farblogiken ohne klaren Bezug zum bestehenden System.
- kleine, schwer lesbare Meta-Texte fuer wichtige Informationen.

## Karte

Die Karte ist ein eigener Hauptscreen. Sie zeigt standardmaessig die aktuell
gewaehlte Reise bzw. bei Bedarf die aktuelle Live-Position.

Kartenmodi:

- Tag
- Tempo
- Hoehe

`Tag` ist die Standardansicht. Die Legende zeigt bei Tag nur kompakte Zahlen
wie `1 2 4`, nicht ausgeschriebene Label wie `Tag 1`.

Layer:

- Uebernachtungen
- Orte
- Notizen
- km-Marker

Die Layer-Auswahl wird gespeichert. Das Metrik-Menue und das Layer-Menue duerfen
nicht gleichzeitig offen sein.

Fahrtfilter:

- `Etappen` zeigt nur als Etappe markierte Fahrten.
- `Versorgung` zeigt nur Abstecher bzw. Versorgungsfahrten.
- `Alle` zeigt beides.
- Der Filter wirkt auf Karte, Gesamtstatistik, Tagesliste und Fahrtenliste.
- Einzelne Abstecher duerfen weiterhin separat "auf Karte" angezeigt werden.

Wichtig: Die Karte darf nicht mehr auf die alte Logik "Etappe = alles ausser
Abstecher" zurueckfallen, sobald Fahrtberichte vorhanden sind.

Wenn eine einzelne Fahrt oder ein einzelner Tag auf der Karte angezeigt wird,
muss es einen einfachen Weg zurueck zur Reise-Gesamtkarte geben. Der Begriff
dafuer ist "Zurueck", nicht "Reise anzeigen".

## Reisen, Tage und Fahrten

Das Datenmodell im Kopf behalten:

- Reise = benannte Zeitspanne.
- Tag = Reisetag innerhalb dieser Zeitspanne.
- Fahrt = konkrete Bewegung aus dem Fahrtbericht.
- Abstecher = Fahrtart fuer Versorgung/kurze Nebenwege.
- Etappe = Fahrtart fuer die eigentliche Reisestrecke.

Die Reiseansicht hat die Segmente:

- Gesamt
- Tage
- Fahrten

Im Detail gilt:

- Gesamt zeigt die Statistik der Reise.
- Tage zeigt Tageskarten mit Strecke und gut lesbaren Werten.
- Fahrten ist nach Tagen gruppiert.
- Ein aufgeklappter Fahrten-Tag bleibt beim Oeffnen und Zurueckgehen erhalten.
- Klick auf Tag oder Fahrt fuehrt in die jeweilige Detailstatistik.
- In Detailansichten soll unter der Statistik nicht wieder die ganze Liste
  stehen. Es gibt einen klaren Zurueck-Weg.

Fahrtdetails:

- `Fahrtart` steht ganz oben in der Statistik.
- Dort kann zwischen `Etappe` und `Abstecher` gewechselt werden.
- Die Aenderung wirkt optimistisch sofort, wird aber zentral gespeichert und
  bei Fehlern sichtbar zurueckgenommen.
- Fahrtdetails zeigen keine `Uebernachtungsplaetze`.

Tagesdetails:

- Tageswerte beziehen sich auf den Tag, nicht auf die Gesamt-Reise.
- Falls eine Kontextzeile gebraucht wird, sind Stopps sinnvoller als
  Uebernachtungsplaetze.
- Leere Tage ohne Strecke sollen nicht als Tageskarte erscheinen.

## Logbuch

Das Logbuch ist die erzaehlte, chronologische Sicht auf die Reise. Es gehoert
fachlich zur Reise, bleibt aber ein eigener Hauptscreen.

Filter:

- Uebernachtungen
- Orte
- Notizen

Alle drei Filter sind echte Umschalter. Wenn alle ausgeschaltet sind, wird
nichts angezeigt. Wenn alle eingeschaltet sind, wird alles angezeigt.

Logbucheintraege:

- Tage sind ein- und ausklappbar.
- Die Tageszeile und die Eintraege muessen optisch in der gleichen linken
  Flucht liegen wie die oberen Bedienelemente.
- Der Zeitstrahl bleibt sichtbar und endet mit dem letzten Eintrag.
- Die Uhrzeit sitzt am Zeitstrahl und darf nicht mit dem Text kollidieren.
- Eintraege sind reduziert: Titel, Kategorie/Attribute, kurzer Text.
- Sterne, Wetter und weitere Details gehoeren eher in die Detailansicht, nicht
  in die Liste.
- Notizen brauchen einen Pflicht-Titel.

Kategorien heissen einheitlich:

- Uebernachtung
- Ort
- Notiz

Automatisch fortgefuehrte Uebernachtungen:

- werden als Anzeigeeintrag dargestellt, nicht als editierbares Feld.
- sind filigraner und flacher als normale Eintraege.
- haben den Ortstitel als Titel, z. B. `Zuhause`.
- zeigen rechts die Kategorie `Uebernachtung (2)` oder entsprechend.
- nutzen ein kleines Automatik-Symbol statt langer Texte wie "automatisch".
- keine Uhrzeit, wenn es nur eine Fortschreibung ist.

Der eingeklappte Bereich `Orte & Kategorien verwalten` darf beim Wechsel ins
Logbuch nicht unnoetig neu gerendert werden. Er wird erst aufgebaut, wenn er
geoeffnet ist.

## Mehr

Der Mehr-Screen ist kein Sammelsurium. Er hat Segmente:

- Wache
- Status
- Einstellungen

Standard ist `Einstellungen`. Nur das aktive Segment ist orange.

Status enthaelt App-/Debug-/Systeminformationen. Wache ist nur dort voll
bedienbar, wo Funktionen wirklich angebunden sind. Keine leeren oder scheinbar
aktiven Attrappen.

## Uebernachtungen

Automatische Uebernachtungen sind lange Nacht-Stopps, keine Datumswechsel.
Die aktuelle Regel steht in `src/overnight-rules.js` und ist in
`docs/concept.md` dokumentiert:

- mindestens 5 Stunden Stand,
- Nachtfenster 22:00 bis 06:00,
- mindestens 2 Stunden im Nachtfenster,
- Live-Position gilt weiterhin als stehend.

Mehrere Naechte am selben Ort:

- Logbuch: mehrere Uebernachtungsereignisse koennen sichtbar sein.
- Statistik: derselbe Ort bleibt ein Uebernachtungsplatz.

Nacht durchfahren erzeugt keine Uebernachtung. Ein sehr frueher Aufbruch ist ein
Grenzfall und muss spaeter anhand echter Daten weiter beobachtet werden.

## Performance und Datenfluss

Nicht "irgendwas im Hintergrund machen", wenn die App hakt. Erst verstehen:

- Welche Ansicht rendert?
- Welche Daten werden geladen?
- Wird unsichtbarer Inhalt neu aufgebaut?
- Wird die Karte neu eingepasst, obwohl nur Daten nachwachsen?
- Gibt es ein Ereignis, das nicht an die Karte oder Liste weitergereicht wird?

Beispiele fuer bestehende Entscheidungen:

- Fahrtart-Aenderungen senden ein `drives`-Ereignis, damit Listen und Karte
  sofort konsistent sind.
- Die Live-Spur waechst im Hintergrund, ohne die Karte jedes Mal neu
  einzupassen.
- Der letzte App-Zustand wird lokal vorgehalten, damit die App beim Start
  sofort sinnvoll aussieht.

Lokale Snapshots sind UX-seitig gut, aber datenschutzrelevant. Änderungen daran
muessen dokumentiert werden.

## Testing, GitHub, Deploy

Vor einem fertigen Stand:

1. `npm test`
2. `npm run build`
3. `npm run test:smoke`
4. `git diff --check`
5. Todo/Konzept/Doku aktualisieren, wenn sich Verhalten oder offene Punkte
   aendern.
6. Commit mit sprechender Message.
7. Push nach GitHub.
8. Cloudflare Pages deployen.
9. Produktion kurz pruefen.
10. GitHub Actions pruefen.

Wenn ein Test wegen Sandbox/Port/Netz nicht laufen kann, nicht ignorieren:
denselben Test mit passender Freigabe erneut ausfuehren oder den Grund klar
dokumentieren.

Nie als fertig melden, wenn:

- nur die UI geaendert wurde, aber Speicherung fehlt,
- Tests nicht gelaufen sind,
- der Stand nicht committed/gepusht ist, obwohl er live gehen soll,
- ein Live-Deploy erwartet war, aber nicht erfolgt ist.

## Dokumentationspflicht

Bei jeder groesseren Aenderung:

- `docs/concept.md`: Datenmodell, Regeln und Architekturentscheidungen
  aktualisieren.
- Diese Datei: nur anpassen, wenn sich die UX-Grundhaltung oder stabile
  Arbeitsweise aendert.

Kleine Bugfixes brauchen nicht jedes Mal einen Roman, aber sie muessen im Commit
und gegebenenfalls im Todo nachvollziehbar sein.

## Was bereits wichtig umgesetzt wurde

- Echte PWA mit Karte, Reisen, Logbuch und Mehr.
- Zentrale Reiseauswahl auf Karte/Reisen/Logbuch.
- Reiseansicht mit Gesamt/Tage/Fahrten.
- Logbuch mit Uebernachtungen/Orte/Notizen und Tagesgruppen.
- Fahrtart Etappe/Abstecher mit zentralem Filter fuer Karte und Statistiken.
- Kompakte Datumsanzeige.
- Automatische Uebernachtungserkennung mit dokumentierter Nacht-Stopp-Regel.
- Lokaler letzter Stand fuer schnellen App-Start.
- Passwortwechsel.
- Debug-Export.
- CI mit Tests, Build, Smoke-Test und Audit.
- Deploy auf Cloudflare Pages.

Diese Punkte sind nicht "Deko", sondern Teil des Produkts. Spaetere Aenderungen
muessen sie erhalten oder bewusst und dokumentiert weiterentwickeln.
