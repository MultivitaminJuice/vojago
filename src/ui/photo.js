// Scale photos down before uploading — phone photos are often several MB, which
// would cost mobile data and storage for nothing. Runs entirely in the browser
// (canvas); nothing unscaled leaves the device.
const MAX_DIM = 1600;
const QUALITY = 0.82;

/** File → scaled-down JPEG blob plus its actual size. */
export async function compressPhoto(file, { maxDim = MAX_DIM, quality = QUALITY } = {}) {
  // `imageOrientation: "from-image"` applies the EXIF rotation — otherwise
  // portrait photos lie sideways in some browsers.
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

// Reading EXIF (time taken, GPS) is deliberately not done here — parsing it by
// hand would be error-prone; if an import from EXIF comes, it deserves a proper,
// tested library. The upload time serves as the time taken for now.
