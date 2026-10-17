// Fotos vor dem Hochladen verkleinern — Handyfotos sind oft mehrere MB groß,
// das würde sowohl beim mobilen Datenvolumen als auch beim Speicherplatz
// unnötig ins Gewicht fallen. Läuft komplett im Browser (Canvas), nichts
// Unverkleinertes verlässt das Gerät.
const MAX_DIM = 1600;
const QUALITY = 0.82;

/** Datei -> verkleinertes JPEG-Blob + tatsächliche Maße. */
export async function komprimiereFoto(file, { maxDim = MAX_DIM, quality = QUALITY } = {}) {
  // `imageOrientation: "from-image"` sorgt dafür, dass die EXIF-Drehung
  // berücksichtigt wird — sonst liegen hochkant aufgenommene Fotos in
  // manchen Browsern quer.
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => createImageBitmap(file));
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Bild konnte nicht verarbeitet werden"))), "image/jpeg", quality);
  });
  return { blob, width, height };
}

// EXIF-Auswertung (Aufnahmezeit/GPS für den automatischen Fotoimport,
// Schritt 2) bewusst noch nicht hier — von Hand geparst wäre das
// fehleranfällig; wenn der Import kommt, verdient das eine richtige,
// getestete Bibliothek statt einer selbstgebauten Bytefolge-Auswertung.
// Für Schritt 1 reicht der Upload-Zeitpunkt als Aufnahmezeit.
