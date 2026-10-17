import { db } from "./store.js";

export function parseAllowedDeviceIds(value = process.env.TRACKER_ALLOWED_DEVICE_IDS || "") {
  return new Set(
    String(value)
      .split(/[\s,]+/)
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

function cleanDeviceId(deviceId) {
  return String(deviceId || "").trim();
}

export function learningUntil() {
  const row = db.prepare("SELECT value FROM ingest_settings WHERE key = 'learning_until'").get();
  const value = Number(row?.value || 0);
  return Number.isFinite(value) ? value : 0;
}

export function isLearningActive(now = Date.now()) {
  return learningUntil() > now;
}

export function setLearningUntil(until) {
  db.prepare(
    "INSERT INTO ingest_settings (key, value) VALUES ('learning_until', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(Math.max(0, Number(until) || 0)));
}

export function markDeviceSeen(deviceId, protocol, accepted = false, now = Date.now()) {
  const id = cleanDeviceId(deviceId);
  if (!id) return;
  db.prepare(
    `INSERT INTO known_devices (device_id, first_seen, last_seen, protocol, accepted)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       last_seen = excluded.last_seen,
       protocol = excluded.protocol,
       accepted = CASE WHEN known_devices.accepted = 1 OR excluded.accepted = 1 THEN 1 ELSE 0 END`
  ).run(id, now, now, protocol || "unknown", accepted ? 1 : 0);
}

function vehicleAllows(id) {
  return Boolean(db.prepare(
    "SELECT 1 FROM vehicles WHERE trim(coalesce(traccar_device_id, '')) = ? LIMIT 1"
  ).get(id));
}

export function isDeviceAllowed(deviceId, { allowed = parseAllowedDeviceIds(), protocol = "unknown", now = Date.now() } = {}) {
  const id = cleanDeviceId(deviceId);
  if (!id) return false;
  const accepted = allowed.has(id) || vehicleAllows(id);
  if (accepted) {
    markDeviceSeen(id, protocol, true, now);
    return true;
  }
  if (isLearningActive(now)) {
    markDeviceSeen(id, protocol, false, now);
    return true;
  }
  markDeviceSeen(id, protocol, false, now);
  return false;
}
