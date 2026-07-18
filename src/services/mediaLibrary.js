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
/**
 * @param {string[]} [exclude] captions to skip (already tried / blocked as dup)
 */
export function pickCaption(
  captions,
  slotIndex = 0,
  pickMode = "random",
  captionsFolder = "",
  exclude = []
) {
  const fromDisk = loadCaptionsFromDisk(captionsFolder);
  const inline = Array.isArray(captions)
    ? captions.map((c) => String(c).trim()).filter(Boolean)
    : [];
  // Disk first (kho), then inline extras
  let list = [...fromDisk, ...inline.filter((c) => !fromDisk.includes(c))];
  if (!list.length) return "";

  // Caption policy is intentionally fixed:
  // - cycle 0: preserve the source order from beginning to end;
  // - later cycles: use a stable shuffled order, so restart/retry does not
  //   unexpectedly change the caption assigned to a slot.
  const index = Math.max(0, Number(slotIndex) || 0);
  const cycle = Math.floor(index / list.length);
  const offset = index % list.length;
  const ordered = captionOrderForCycle(list, cycle);
  const ban = new Set((exclude || []).map((c) => String(c).trim().toLowerCase()));
  for (let step = 0; step < ordered.length; step++) {
    const candidate = ordered[(offset + step) % ordered.length];
    if (!ban.has(String(candidate).trim().toLowerCase())) return candidate;
  }
  return "";
}

function stableShuffle(list, cycle) {
  const out = [...list];
  let seed = 2166136261 ^ cycle;
  for (const item of list) {
    for (const ch of String(item)) {
      seed ^= ch.charCodeAt(0);
      seed = Math.imul(seed, 16777619) >>> 0;
    }
  }
  const random = () => {
    seed += 0x6d2b79f5;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  // A shuffled cycle should not accidentally be identical to the source
  // order when there is enough choice.
  if (out.length > 1 && out.every((x, i) => x === list[i])) {
    out.push(out.shift());
  }
  return out;
}

function captionOrderForCycle(list, cycle) {
  if (cycle === 0) return [...list];
  const out = stableShuffle(list, cycle);
  const previous = captionOrderForCycle(list, cycle - 1);
  if (out.length > 1 && out.every((item, i) => item === previous[i])) {
    out.push(out.shift());
  }
  if (out.length > 1 && out[0] === previous[previous.length - 1]) {
    out.push(out.shift());
  }
  return out;
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
