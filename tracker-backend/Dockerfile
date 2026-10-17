# VOJAĜO Tracker-Backend — schlanker GPS-Empfangsdienst (OsmAnd, Teltonika Codec8/8E).
#
# Braucht seit der serverseitigen Übernachtungs-/Stopp-Erkennung
# (src/auto-import.js, 6. September 2026) den Repo-WURZEL als Build-
# Kontext (nicht tracker-backend/ selbst), weil zwei bewusst
# abhängigkeitsfreie Bausteine aus dem Hauptprojekt mitgenutzt werden,
# statt sie zu duplizieren: api/lib.js (segmentStops/klassifiziereKanten,
# Wetter-/Reverse-Geocoding-Abruf) und src/overnight-rules.js
# (Übernachtungs-/Stopp-Entscheidung). Siehe docker-compose.yml am
# Repo-Root: "context: .", "dockerfile: tracker-backend/Dockerfile" —
# derselbe Grund, aus dem app-backend/Dockerfile schon so gebaut wird.
# Deshalb NICHT mit `docker build tracker-backend/` bauen, sondern über
# die Compose-Datei bzw. `docker build -f tracker-backend/Dockerfile .`
# vom Repo-Root aus.
#
# node:22-slim (Debian, glibc) — better-sqlite3 bringt fertig kompilierte
# Binärdateien nur für glibc-Linux mit. Node statt Bun: der Heimserver hat
# eine CPU ohne AVX-Unterstützung, auf der Bun abstürzt (siehe Git-Historie).
FROM node:22-slim

# Die Übernachtungs-/Stopp-Erkennung (src/overnight-rules.js) rechnet
# bewusst mit LOKALEN Uhrzeiten (22–6 Uhr "Nacht", Kalendertag-Grenzen
# über new Date().getHours()/getFullYear()/... — dieselben Funktionen wie
# im Browser, wo "lokal" automatisch die Zeitzone des Nutzers ist). Ein
# Container läuft ohne diese Zeile in UTC — die Nachtfenster-Prüfung wäre
# um 1–2 Stunden verschoben (CET/CEST). Fest auf die Zeitzone der Nutzung
# gesetzt, nicht konfigurierbar über Umgebungsvariable — passend zum
# bewusst schlanken, auf einen Haushalt zugeschnittenen Betrieb dieses
# Projekts (siehe auch: kein Zonen-Konzept in alarms.js).
ENV TZ=Europe/Berlin

WORKDIR /app
COPY tracker-backend/package.json ./tracker-backend/package.json
RUN cd tracker-backend && npm install --omit=dev

COPY tracker-backend/schema.sql ./tracker-backend/schema.sql
COPY tracker-backend/src ./tracker-backend/src
COPY api/lib.js ./api/lib.js
COPY src/overnight-rules.js ./src/overnight-rules.js

# Die Datenbank liegt in einem Volume, nicht im Image — sonst wäre jedes
# Neubauen des Containers ein Datenverlust. (In Produktion überschreibt
# docker-compose.yml TRACKER_DB_PATH ohnehin auf /data/vojago.db, geteilt
# mit dem app-Container — dieser Vorgabewert gilt nur für einen
# eigenständigen `docker run` ohne Compose.)
VOLUME ["/app/tracker-backend/data"]
ENV TRACKER_DB_PATH=/app/tracker-backend/data/tracker.db

WORKDIR /app/tracker-backend

EXPOSE 5055
EXPOSE 5027

CMD ["node", "src/server.js"]
