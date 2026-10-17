# VOJAĜO app-Container (Phase 2) — Web-App + /api/*
# auf Node, mit api/router.js UNVERÄNDERT aus dem Hauptprojekt.
#
# Braucht den Repo-WURZEL als Build-Kontext (nicht app-backend/ selbst), weil
# api/, db/schema.sql und (über die erste Stufe) src/+scripts/ außerhalb
# dieses Verzeichnisses liegen — siehe docker-compose.yml am Repo-Root:
# "context: .", "dockerfile: app-backend/Dockerfile". Deshalb NICHT mit
# `docker build app-backend/` bauen, sondern über die Compose-Datei bzw.
# `docker build -f app-backend/Dockerfile .` vom Repo-Root aus.
#
# Zwei Stufen: public/ ist ein Build-Ergebnis (npm run build, siehe
# scripts/build-site.mjs) und bewusst NICHT eingecheckt (.gitignore) — ein
# frischer Git-Checkout (genau das, was Portainers "Repository"-Build-
# Methode macht) hat also nie ein fertiges public/ dabei. Erste Stufe baut
# es, zweite Stufe übernimmt nur das Ergebnis, nicht esbuild/devDependencies.
FROM node:22-slim AS site-builder
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm install
COPY src ./src
COPY scripts ./scripts
# Kartenschlüssel (CARTO) kommt beim Bauen aus der Umgebung, nicht aus dem
# Quelltext (siehe README, "Map tiles"). Ohne Wert zeigt die Karte Wasserzeichen.
ARG CARTO_API_KEY=""
ENV CARTO_API_KEY=${CARTO_API_KEY}
# Build-Nummer und Commit für die Anzeige in der App (im Image gibt es kein
# .git, siehe scripts/build-info.mjs). Ohne Werte zeigt die App den Hash.
ARG BUILD_NUMBER=""
ARG BUILD_COMMIT=""
ENV BUILD_NUMBER=${BUILD_NUMBER} BUILD_COMMIT=${BUILD_COMMIT}
RUN npm run build

# Verzeichnistiefe im Image bewusst identisch zum lokalen Checkout gehalten
# (/app/api, /app/app-backend/src, ...) — server.js/d1-shim.js verwenden
# relative Pfade wie im Repo (../../api/router.js, ../../db/schema.sql), die
# so ohne Sonderfälle/Environment-Overrides auch im Container stimmen.
#
# node:22-slim (Debian, glibc) — wie tracker-backend/Dockerfile, aus
# demselben Grund: better-sqlite3 bringt fertig kompilierte Binärdateien nur
# für glibc-Linux mit.
FROM node:22-slim

WORKDIR /app
COPY app-backend/package.json ./app-backend/package.json
RUN cd app-backend && npm install --omit=dev

COPY db/schema.sql ./db/schema.sql
COPY api ./api
COPY --from=site-builder /build/public ./public
COPY app-backend/src ./app-backend/src

# Die Datenbank (geteilt mit dem ingest-Container) und die Fotos liegen in
# einem Volume, nicht im Image.
VOLUME ["/data"]
ENV APP_DB_PATH=/data/vojago.db
ENV APP_PHOTOS_PATH=/data/fotos

EXPOSE 8080

CMD ["node", "app-backend/src/server.js"]
