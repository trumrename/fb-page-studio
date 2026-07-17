import fs from "fs";
import path from "path";

const IMAGE_EXT = /\.(jpe?g|png|gif|bmp|webp|tiff?)$/i;
const VIDEO_EXT = /\.(mp4|mov|avi|mkv|webm|m4v)$/i;

export function ensureDir(dir) {
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
}

export function listMediaFiles(folder, kind = "any") {
  if (!folder || !fs.existsSync(folder)) return [];
  const files = fs
    .readdirSync(folder)
    .map((f) => path.join(folder, f))
    .filter((f) => fs.statSync(f).isFile());

  if (kind === "photo" || kind === "image") {
    return files.filter((f) => IMAGE_EXT.test(f)).sort();
  }
  if (kind === "video") {
    return files.filter((f) => VIDEO_EXT.test(f)).sort();
  }
  return files
    .filter((f) => IMAGE_EXT.test(f) || VIDEO_EXT.test(f))
    .sort();
}

/**
 * Pick one media file. sequential uses index % length; random uses Math.random.
 * Returns null if none.
 */
export function pickMedia(folder, kind, pickMode = "sequential", slotIndex = 0) {
  const files = listMediaFiles(folder, kind);
  if (!files.length) return null;
  if (pickMode === "random") {
    return files[Math.floor(Math.random() * files.length)];
  }
  return files[slotIndex % files.length];
}

/** Move file into postedDir (create if needed). Returns new path. */
export function moveToPosted(filePath, postedDir) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`Cannot move missing file: ${filePath}`);
  }
  ensureDir(postedDir);
  const base = path.basename(filePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let dest = path.join(postedDir, `${stamp}_${base}`);
  if (fs.existsSync(dest)) {
    dest = path.join(postedDir, `${stamp}_${Math.random().toString(36).slice(2)}_${base}`);
  }
  fs.renameSync(filePath, dest);
  return dest;
}

/**
 * Load captions from a file or folder of .txt / .csv
 * - .txt: mỗi dòng 1 caption (bỏ dòng trống, bỏ dòng bắt đầu bằng #)
 * - .csv: cột "caption" / "text" / "content" nếu có header; không thì cột đầu
 * - folder: gộp tất cả .txt/.csv trong folder (không đệ quy)
 * Không bịa caption — file rỗng / không tồn tại → []
 */
export function loadCaptionsFromDisk(captionsPath) {
  if (!captionsPath || !String(captionsPath).trim()) return [];
  const p = path.resolve(String(captionsPath).trim());
  if (!fs.existsSync(p)) return [];

  const files = [];
  const st = fs.statSync(p);
  if (st.isFile()) {
    files.push(p);
  } else if (st.isDirectory()) {
    for (const name of fs.readdirSync(p)) {
      if (/\.(txt|csv)$/i.test(name)) {
        files.push(path.join(p, name));
      }
    }
    files.sort();
  }

  const out = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    // strip BOM
    const text = raw.replace(/^\uFEFF/, "");
    if (/\.csv$/i.test(file)) {
      out.push(...parseCaptionsCsv(text));
    } else {
      out.push(...parseCaptionsTxt(text));
    }
  }
  // unique keep order, no empty
  const seen = new Set();
  const list = [];
  for (const c of out) {
    const t = String(c).trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    list.push(t);
  }
  return list;
}

function parseCaptionsTxt(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function parseCaptionsCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];

  // Simple CSV split (handles quoted fields with commas)
  const splitCsvLine = (line) => {
    const cols = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (q && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = !q;
      } else if (ch === "," && !q) {
        cols.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    cols.push(cur.trim());
    return cols.map((c) => c.replace(/^"|"$/g, "").trim());
  };

  const rows = lines.map(splitCsvLine);
  const header = rows[0].map((h) => h.toLowerCase());
  const captionIdx = header.findIndex((h) =>
    ["caption", "text", "content", "message", "noi_dung", "mota", "mo_ta"].includes(h)
  );

  if (captionIdx >= 0) {
    return rows
      .slice(1)
      .map((r) => r[captionIdx] || "")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // No header match: treat every non-empty first cell as caption (including row 0 if not header-like)
  const looksLikeHeader =
    header.length > 1 ||
    ["caption", "text", "id", "stt", "name"].includes(header[0]);
  const start = looksLikeHeader && header.length > 0 ? 1 : 0;
  return rows
    .slice(start)
    .map((r) => r[0] || "")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Merge captions from disk folder/file + optional inline list.
 * pickMode: random (default for disk pool) | sequential
 */
export function pickCaption(
  captions,
  slotIndex = 0,
  pickMode = "random",
  captionsFolder = ""
) {
  const fromDisk = loadCaptionsFromDisk(captionsFolder);
  const inline = Array.isArray(captions)
    ? captions.map((c) => String(c).trim()).filter(Boolean)
    : [];
  // Disk first (kho), then inline extras
  const list = [...fromDisk, ...inline.filter((c) => !fromDisk.includes(c))];
  if (!list.length) return "";
  const mode = pickMode === "sequential" ? "sequential" : "random";
  if (mode === "random") {
    return list[Math.floor(Math.random() * list.length)];
  }
  return list[slotIndex % list.length];
}

export function captionPoolStats(captionsFolder, inlineCaptions = []) {
  const fromDisk = loadCaptionsFromDisk(captionsFolder);
  const inline = Array.isArray(inlineCaptions)
    ? inlineCaptions.filter((c) => String(c).trim())
    : [];
  return {
    from_disk: fromDisk.length,
    from_inline: inline.length,
    total: new Set([...fromDisk, ...inline.map((c) => String(c).trim())]).size,
    folder: captionsFolder || null,
  };
}

/**
 * Build comment from templates + link lists.
 * Placeholders: {see_more}, {full_album}, {link}, {link:key}
 * Missing lists → leave placeholder empty (no fake links).
 */
export function buildComment(templates, linkLists = {}, pickMode = "random") {
  const list = Array.isArray(templates) ? templates.filter((t) => String(t).trim()) : [];
  if (!list.length) return null;

  let tpl =
    pickMode === "sequential"
      ? list[0]
      : list[Math.floor(Math.random() * list.length)];

  const pickLink = (key) => {
    const arr = linkLists?.[key];
    if (!Array.isArray(arr) || !arr.length) return "";
    return arr[Math.floor(Math.random() * arr.length)];
  };

  // {link:see_more} or {see_more}
  tpl = tpl.replace(/\{link:([a-zA-Z0-9_]+)\}/g, (_, key) => pickLink(key));
  tpl = tpl.replace(/\{see_more\}/g, () => pickLink("see_more"));
  tpl = tpl.replace(/\{full_album\}/g, () => pickLink("full_album"));
  tpl = tpl.replace(/\{link\}/g, () => {
    const all = Object.values(linkLists || {}).flat().filter(Boolean);
    if (!all.length) return "";
    return all[Math.floor(Math.random() * all.length)];
  });

  return tpl.trim() || null;
}
