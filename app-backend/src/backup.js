// Full backup as one download: a consistent copy of the SQLite database and
// all photo files, packed as .tar.gz. Built for "Settings → Backup" so the
// owner can keep the file wherever they like. No dependencies: the tar
// format (ustar) is small enough to write here.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

const BLOCK = 512;

function octal(value, length) {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

/** One tar header (ustar). Names longer than 100 bytes use the prefix field. */
function header(name, size, mtimeSeconds) {
  const buf = Buffer.alloc(BLOCK, 0);
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`path too long for tar: ${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  buf.write(base, 0, 100, "utf8");
  buf.write(octal(0o644, 8), 100, 8, "ascii");
  buf.write(octal(0, 8), 108, 8, "ascii");
  buf.write(octal(0, 8), 116, 8, "ascii");
  buf.write(octal(size, 12), 124, 12, "ascii");
  buf.write(octal(mtimeSeconds, 12), 136, 12, "ascii");
  buf.write("        ", 148, 8, "ascii"); // checksum placeholder
  buf.write("0", 156, 1, "ascii");        // regular file
  buf.write("ustar\0", 257, 6, "ascii");
  buf.write("00", 263, 2, "ascii");
  buf.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return buf;
}

/** Tar archive of the given entries ({ name, data, mtime }). */
export function tar(entries) {
  const teile = [];
  for (const { name, data, mtime = new Date() } of entries) {
    teile.push(header(name, data.length, Math.floor(mtime.getTime() / 1000)), data);
    const rest = data.length % BLOCK;
    if (rest) teile.push(Buffer.alloc(BLOCK - rest, 0));
  }
  teile.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(teile);
}

function dateienUnter(verzeichnis) {
  let liste = [];
  let eintraege;
  try { eintraege = readdirSync(verzeichnis, { withFileTypes: true }); } catch { return []; }
  for (const e of eintraege) {
    const pfad = join(verzeichnis, e.name);
    if (e.isDirectory()) liste = liste.concat(dateienUnter(pfad));
    else if (e.isFile()) liste.push(pfad);
  }
  return liste;
}

/**
 * Builds the backup. `db` is the better-sqlite3 connection; its online
 * backup gives a consistent copy while the ingest container keeps writing.
 * Returns { data: Buffer (.tar.gz), filename, manifest }.
 */
export async function createBackup({ db, photosDir, now = new Date() }) {
  const arbeit = mkdtempSync(join(tmpdir(), "vojago-backup-"));
  try {
    const dbKopie = join(arbeit, "vojago.db");
    await db.backup(dbKopie);
    const fotos = dateienUnter(photosDir).sort();
    const manifest = {
      format: "vojago-backup",
      version: 1,
      createdAt: now.toISOString(),
      database: "vojago.db",
      photos: fotos.length,
      counts: Object.fromEntries(["trips", "besuche", "notes", "tagebuch", "photos", "positions", "users"].map((t) => {
        try { return [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]; } catch { return [t, null]; }
      })),
    };
    const entries = [
      { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n"), mtime: now },
      { name: "vojago.db", data: readFileSync(dbKopie), mtime: now },
      ...fotos.map((pfad) => ({
        name: `fotos/${relative(photosDir, pfad).split("\\").join("/")}`,
        data: readFileSync(pfad),
        mtime: statSync(pfad).mtime,
      })),
    ];
    const tag = now.toISOString().slice(0, 10);
    return { data: gzipSync(tar(entries), { level: 6 }), filename: `vojago-backup-${tag}.tar.gz`, manifest };
  } finally {
    rmSync(arbeit, { recursive: true, force: true });
  }
}
