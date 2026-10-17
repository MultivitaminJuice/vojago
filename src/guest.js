// Gast-Ansicht: Reisen über einen Freigabe-Link ansehen, ohne eigenes Konto.
//
// Bewusst KEINE eigene Kopie der Datenlogik — dieselben Baublöcke wie in
// dataload.js (toTrip/toPlace/toNote, positionsToPath, tagesKilometer) und
// geo.js/day-utils.js kommen hier zum Einsatz, nur aus einer anderen Quelle:
// dem öffentlichen Freigabe-Endpunkt statt der angemeldeten API. Die eigent-
// liche Sicherheitsgrenze liegt ohnehin serverseitig (siehe api/router.js
// /api/share/...) — hier geht es nur darum, dieselben Render-Funktionen
// (renderTrips, renderJournal, die Karte) unverändert weiterzuverwenden.
import { state, emit } from "./state.js";
import { toTrip, toPlace, toNote, toPhoto, standardReise, positionsToPath, tagesKilometer } from "./dataload.js";
import { pathLengthKm, elevationRange } from "./geo.js";
import { renumberPathByTripStart } from "./day-utils.js";
import { fetchShare, fetchShareRoute, fetchSharePositions, fetchShareDrives } from "./api.js";

let aktiverToken = null;

/** Lädt die Übersicht (Reise(n) + je nach Umfang Logbuch) für einen Freigabe-Link. */
export async function starteGastAnsicht(token) {
  aktiverToken = token;
  const antwort = await fetchShare(token);
  state.gast = { scope: antwort.scope, alleReisen: antwort.alleReisen, label: antwort.label || "", token };
  state.trips = (antwort.trips || []).map(toTrip);
  state.places = (antwort.places || []).map(toPlace);
  state.notes = (antwort.notes || []).map(toNote);
  state.photos = (antwort.photos || []).map(toPhoto);
  if (antwort.categories?.length) {
    state.categories = Object.fromEntries(antwort.categories.map((c) => [c.id, { name: c.name, color: c.color || "#888" }]));
  }
  const standard = standardReise(state.trips);
  state.activeTripId = standard?.live ? standard.id : null;
  state.mapTripId = standard?.id || null;
  emit("trips");
  if (standard) await ladeGastRoute(standard);
  return antwort;
}

/** Nur die aktuelle Position — leichtgewichtig, fürs häufige Nachfragen
 * (Gegenstück zu loadLivePosition()). Nur sinnvoll bei laufender Reise. */
export async function ladeGastLivePosition(trip) {
  if (!trip?.live || !aktiverToken) return;
  try {
    const liste = await fetchSharePositions(aktiverToken, trip.id);
    const p = Array.isArray(liste) ? liste[0] : null;
    if (!p || !Number.isFinite(p.longitude) || !Number.isFinite(p.latitude)) return;
    state.livePosition = {
      lon: p.longitude, lat: p.latitude,
      at: p.fixTime || p.deviceTime || null,
      speed: Number.isFinite(p.speed) ? p.speed * 1.852 : 0,
    };
    emit("livePosition");
  } catch {
    /* stiller Fehlschlag — die Karte bleibt einfach, wie sie ist */
  }
}

/** Route + Fahrten-Einordnung (+ einmalig Live-Position) einer einzelnen
 * Reise — Gegenstück zu ensureTripPath()/loadDrives() im angemeldeten
 * Betrieb, nur über den öffentlichen Endpunkt. Die Fahrten-Einordnung
 * (Etappe/Abstecher) muss VOR dem Zeichnen feststehen — sonst zeigt die
 * Karte mangels Filterkriterium kurz die volle, ungefilterte Strecke
 * (inklusive Versorgungsfahrten & Co.) statt nur der Etappen. Stiller
 * Fehlschlag: die Karte bleibt ohne Route stehen. */
export async function ladeGastRoute(trip) {
  if (!trip || !aktiverToken) return;
  try {
    const [positionen, fahrten] = await Promise.all([
      fetchShareRoute(aktiverToken, trip.id),
      fetchShareDrives(aktiverToken, trip.id).catch(() => []),
    ]);
    // Fahrten anderer Reisen (bei "alle Reisen" nacheinander geladen) bleiben
    // erhalten — nur die dieser Reise werden ersetzt.
    state.drives = state.drives.filter((d) => d.tripId !== trip.id).concat(fahrten || []);
    trip.path = renumberPathByTripStart(positionsToPath(positionen), trip);
    if (trip.path.length) {
      trip.km = Math.round(pathLengthKm(trip.path));
      trip.peak = Math.round(elevationRange(trip.path).max);
      const tage = tagesKilometer(trip.path);
      trip.bars = tage.bars;
      trip.barLabels = tage.labels;
    }
    emit("tripPath");
    await ladeGastLivePosition(trip);
  } catch {
    /* Karte bleibt ohne Route stehen — kein Absturz. */
  }
}

/** Wechselt in der "alle Reisen"-Gast-Ansicht auf eine andere Reise. */
export async function zeigeGastReise(tripId) {
  const trip = state.trips.find((t) => t.id === tripId);
  if (!trip) return;
  state.mapTripId = trip.id;
  emit("trips");
  if (!trip.path.length) await ladeGastRoute(trip);
}
