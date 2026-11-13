// Guest view: looking at trips through a sharing link, without an account.
//
// Deliberately NO copy of the data logic — the same building blocks as in
// dataload.js (toTrip/toPlace/toNote, positionsToPath, kmPerDay) and
// geo.js/day-utils.js are used, only from another source: the public sharing
// endpoint instead of the signed-in API. The actual security boundary is on the
// server anyway (see api/router.js /api/share/...) — this is only about reusing
// the same render functions (renderTrips, renderJournal, the map) unchanged.
// Response fields (e.g. alleReisen, tagebuch) follow the API.
import { state, emit } from "./state.js";
import { toTrip, toPlace, toNote, toPhoto, toDiaryEntry, defaultTrip, positionsToPath, kmPerDay } from "./dataload.js";
import { pathLengthKm, elevationRange } from "./geo.js";
import { renumberPathByTripStart } from "./day-utils.js";
import { fetchShare, fetchShareRoute, fetchSharePositions, fetchShareDrives } from "./api.js";

let activeToken = null;

/** Loads the overview (trip(s) and, depending on the scope, the logbook) for a sharing link. */
export async function startGuestView(token) {
  activeToken = token;
  const answer = await fetchShare(token);
  state.guest = { scope: answer.scope, allTrips: answer.alleReisen, label: answer.label || "", token };
  state.trips = (answer.trips || []).map(toTrip);
  state.places = (answer.places || []).map(toPlace);
  state.notes = (answer.notes || []).map(toNote);
  state.photos = (answer.photos || []).map(toPhoto);
  state.diary = (answer.tagebuch || []).map(toDiaryEntry);
  if (answer.categories?.length) {
    state.categories = Object.fromEntries(answer.categories.map((c) => [c.id, { name: c.name, color: c.color || "#888" }]));
  }
  const fallback = defaultTrip(state.trips);
  state.activeTripId = fallback?.live ? fallback.id : null;
  state.mapTripId = fallback?.id || null;
  emit("trips");
  if (fallback) await loadGuestRoute(fallback);
  return answer;
}

/** Only the current position — lightweight, for frequent polling (counterpart
 * of loadLivePosition()). Only useful for a running trip. */
export async function loadGuestLivePosition(trip) {
  if (!trip?.live || !activeToken) return;
  try {
    const list = await fetchSharePositions(activeToken, trip.id);
    const p = Array.isArray(list) ? list[0] : null;
    if (!p || !Number.isFinite(p.longitude) || !Number.isFinite(p.latitude)) return;
    state.livePosition = {
      lon: p.longitude, lat: p.latitude,
      at: p.fixTime || p.deviceTime || null,
      speed: Number.isFinite(p.speed) ? p.speed * 1.852 : 0,
    };
    emit("livePosition");
  } catch {
    /* silent failure — the map simply stays as it is */
  }
}

/** Route and drive kinds (and once the live position) of a single trip —
 * counterpart of ensureTripPath()/loadDrives() for signed-in users, through the
 * public endpoint. The drive kinds (stage/detour) must be known BEFORE drawing —
 * otherwise the map briefly shows the full, unfiltered route (supply drives
 * included) instead of only the stages. Silent failure: the map stays without route. */
export async function loadGuestRoute(trip) {
  if (!trip || !activeToken) return;
  try {
    const [positions, drives] = await Promise.all([
      fetchShareRoute(activeToken, trip.id),
      fetchShareDrives(activeToken, trip.id).catch(() => []),
    ]);
    // Drives of other trips (loaded one after another with "all trips") stay —
    // only those of this trip are replaced.
    state.drives = state.drives.filter((d) => d.tripId !== trip.id).concat(drives || []);
    trip.path = renumberPathByTripStart(positionsToPath(positions), trip);
    if (trip.path.length) {
      trip.km = Math.round(pathLengthKm(trip.path));
      trip.peak = Math.round(elevationRange(trip.path).max);
      const days = kmPerDay(trip.path);
      trip.bars = days.bars;
      trip.barLabels = days.labels;
    }
    emit("tripPath");
    await loadGuestLivePosition(trip);
  } catch {
    /* the map stays without route — no crash */
  }
}

/** Switches to another trip in the "all trips" guest view. */
export async function showGuestTrip(tripId) {
  const trip = state.trips.find((t) => t.id === tripId);
  if (!trip) return;
  state.mapTripId = trip.id;
  emit("trips");
  if (!trip.path.length) await loadGuestRoute(trip);
}
