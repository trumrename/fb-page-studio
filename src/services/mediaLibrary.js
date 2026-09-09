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
    .filter((f) => {
      try { return fs.statSync(f).isFile(); } catch { return false; }
    });

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

/**
 * CHUYỂN file từ kho media → folder posted (MOVE, không copy).
 * - Cùng ổ: rename (atomic)
 * - Khác ổ (EXDEV trên Windows): copy rồi XÓA nguồn — vẫn là chuyển, không để file gốc
 *   trong media (tránh đăng lại).
 * Returns absolute path in postedDir.
 */
export function moveToPosted(filePath, postedDir) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`Cannot move missing file: ${filePath}`);
  }
  ensureDir(postedDir);
  const src = path.resolve(filePath);
  const base = path.basename(src);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let dest = path.join(postedDir, `${stamp}_${base}`);
  if (fs.existsSync(dest)) {
    dest = path.join(postedDir, `${stamp}_${Math.random().toString(36).slice(2)}_${base}`);
  }
  dest = path.resolve(dest);

  try {
    fs.renameSync(src, dest);
    return dest;
  } catch (e) {
    // Cross-device / locked rename → copy then delete source (true move)
    const code = e && (e.code || e.errno);
    const cross =
      code === "EXDEV" ||
      code === "EPERM" ||
      /cross-device|cannot move|EXDEV/i.test(String(e.message || e));
    if (!cross && code !== "EACCES") {
      // Unexpected: still try copy+unlink before giving up
    }
    try {
      fs.copyFileSync(src, dest);
    } catch (copyErr) {
      throw new Error(
        `Không chuyển được file sang posted:\n${src}\n→ ${dest}\n${copyErr.message || copyErr}`
      );
    }
    try {
      fs.unlinkSync(src);
    } catch (delErr) {
      // Destination exists but source still there = would re-post. Try harder.
      try {
        fs.rmSync(src, { force: true });
      } catch {
        /* last resort */
      }
      if (fs.existsSync(src)) {
        throw new Error(
          `Đã copy sang posted nhưng KHÔNG XÓA được file gốc (sẽ bị đăng lại):\n${src}\n${delErr.message || delErr}`
        );
      }
    }
    return dest;
  }
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
  // Iterative — avoids O(cycle) stack depth after thousands of posts.
  let prev = [...list];
  for (let c = 1; c <= cycle; c++) {
    const out = stableShuffle(list, c);
    if (out.length > 1 && out.every((item, i) => item === prev[i])) {
      out.push(out.shift());
    }
    if (out.length > 1 && out[0] === prev[prev.length - 1]) {
      out.push(out.shift());
    }
    prev = out;
  }
  return prev;
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
 * Kho link cho dòng mở đầu caption (lead).
 * Ưu tiên caption_lead_links → comment_links → full_album + see_more.
 */
export function getCaptionLeadLinkPool(linkLists = {}) {
  const ll = linkLists && typeof linkLists === "object" ? linkLists : {};
  const primary = normalizeLineList(ll.caption_lead_links);
  if (primary.length) return primary;
  return getCommentLinkPool(ll);
}

/**
 * Dòng mở đầu caption (tuỳ chọn):
 *   view full album :
 *   https://link...
 *
 *   <caption từ kho tiêu đề>
 *
 * Bật: link_lists.caption_lead_enabled = 1 / true / "on"
 * Mẫu: caption_lead_templates (mỗi dòng 1 câu, random/sequential)
 * Link: caption_lead_links hoặc kho link comment
 *
 * @returns {{ text: string, lead: string|null, link: string|null, link_lists: object }}
 */
export function composeCaptionWithLead(captionBody, cfg = {}) {
  const body = String(captionBody || "").trim();
  const ll0 =
    cfg.link_lists && typeof cfg.link_lists === "object" ? { ...cfg.link_lists } : {};
  const enRaw = ll0.caption_lead_enabled;
  const enabled =
    enRaw === true ||
    enRaw === 1 ||
    enRaw === "1" ||
    String(enRaw || "").toLowerCase() === "on" ||
    String(enRaw || "").toLowerCase() === "true" ||
    String(enRaw || "").toLowerCase() === "yes";

  if (!enabled) {
    return { text: body, lead: null, link: null, link_lists: ll0 };
  }

  const templates = normalizeLineList(
    ll0.caption_lead_templates ?? ll0.caption_lead ?? ll0.title_lead_templates
  );
  const links = getCaptionLeadLinkPool(ll0);
  const mode = getCommentPickMode(
    { comment_link_mode: ll0.caption_lead_mode || ll0.comment_link_mode || "random" },
    "random"
  );

  if (!templates.length && !links.length) {
    return { text: body, lead: null, link: null, link_lists: ll0 };
  }

  let tplNext = Number(ll0.caption_lead_tpl_next) || 0;
  let linkNext = Number(ll0.caption_lead_link_next) || 0;
  let tpl = "";
  let link = "";
  const mediaRef = cfg.media_path || cfg.media_name || "";

  if (templates.length) {
    if (mode === "sequential") {
      const i = Math.abs(tplNext) % templates.length;
      tpl = templates[i];
      tplNext = i + 1;
    } else if (mode === "match_media") {
      const ord = extractOrdinalFromName(mediaRef);
      if (ord != null) {
        const numbered = templates.findIndex((t) => extractOrdinalFromName(t) === ord);
        const idx = numbered >= 0 ? numbered : Math.min(Math.max(ord - 1, 0), templates.length - 1);
        tpl = templates[idx];
        tplNext += 1;
      } else {
        tpl = templates[Math.floor(Math.random() * templates.length)];
        tplNext += 1;
      }
    } else {
      tpl = templates[Math.floor(Math.random() * templates.length)];
      tplNext += 1;
    }
  }
  if (links.length) {
    if (mode === "match_media") {
      const raw =
        normalizeLineList(ll0.caption_lead_links).length
          ? normalizeLineList(ll0.caption_lead_links)
          : normalizeLineList(ll0.comment_links).length
            ? normalizeLineList(ll0.comment_links)
            : links;
      const picked = pickLinkByMediaOrdinal(raw, mediaRef);
      if (picked.url) {
        link = picked.url;
      } else {
        const i = Math.abs(linkNext) % links.length;
        link = links[i];
        linkNext = i + 1;
      }
    } else if (mode === "sequential") {
      const i = Math.abs(linkNext) % links.length;
      link = links[i];
      linkNext = i + 1;
    } else {
      link = links[Math.floor(Math.random() * links.length)];
      linkNext += 1;
    }
  }

  let lead = "";
  if (tpl) {
    const hasPh = /\{link\}|\{see_more\}|\{full_album\}/.test(tpl);
    lead = tpl
      .replace(/\{link\}/g, () => link || "")
      .replace(/\{see_more\}/g, () => link || "")
      .replace(/\{full_album\}/g, () => link || "");
    if (!hasPh && link && !lead.includes(link)) {
      // "view full album :\nhttps://..."
      lead = `${lead.trim()}\n${link}`.trim();
    }
  } else if (link) {
    lead = link;
  }

  const text = [lead, body].filter(Boolean).join("\n\n").trim();
  const link_lists = {
    ...ll0,
    caption_lead_enabled: 1,
    caption_lead_mode: mode,
    caption_lead_tpl_next: tplNext,
    caption_lead_link_next: linkNext,
    caption_lead_templates: templates.length
      ? templates
      : ll0.caption_lead_templates || [],
    caption_lead_links:
      Array.isArray(ll0.caption_lead_links) && ll0.caption_lead_links.length
        ? ll0.caption_lead_links
        : links.length
          ? links
          : ll0.caption_lead_links || [],
  };

  return {
    text: text || body,
    lead: lead || null,
    link: link || null,
    link_lists,
  };
}

/** Normalize list of non-empty strings (1 line = 1 item). */
export function normalizeLineList(raw) {
  if (Array.isArray(raw)) {
    return raw.map((s) => String(s || "").trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Kho link comment của 1 page.
 * Ưu tiên: comment_links → caption_lead_links (cùng kho lead) → full_album + see_more.
 * Tránh case: user dán link ở lead / bulk nhưng comment_links rỗng → comment chỉ còn "see more :".
 */
export function getCommentLinkPool(linkLists = {}) {
  const ll = linkLists && typeof linkLists === "object" ? linkLists : {};
  const buckets = [
    normalizeLineList(ll.comment_links),
    normalizeLineList(ll.caption_lead_links),
    normalizeLineList(ll.full_album),
    normalizeLineList(ll.see_more),
  ];
  const seen = new Set();
  const out = [];
  for (const arr of buckets) {
    for (const line of arr) {
      const parsed = parseLinkEntry(line);
      const u = parsed?.url || String(line || "").trim();
      const k = String(u || "").trim().toLowerCase();
      if (!k || seen.has(k)) continue;
      // chỉ nhận URL-ish (sau khi bỏ số thứ tự "1. https://...")
      if (!/^https?:\/\//i.test(u) && !/^[\w.-]+\.[a-z]{2,}/i.test(u)) continue;
      seen.add(k);
      out.push(String(u).trim());
    }
    // Dùng bucket đầu tiên có dữ liệu (ưu tiên comment_links, rồi lead…)
    if (out.length) break;
  }
  return out;
}

/**
 * random | sequential | match_media (khớp số thứ tự tên file ↔ dòng link)
 */
export function getCommentPickMode(linkLists = {}, fallback = "random") {
  const m = String(linkLists?.comment_link_mode || linkLists?.comment_pick_mode || fallback)
    .trim()
    .toLowerCase();
  if (
    m === "match_media" ||
    m === "by_media" ||
    m === "by_filename" ||
    m === "theo_ten" ||
    m === "theo_ten_media" ||
    m === "media_name"
  ) {
    return "match_media";
  }
  return m === "sequential" || m === "sequence" || m === "theo_bai" ? "sequential" : "random";
}

/**
 * Bỏ prefix stamp khi moveToPosted: 2026-09-09T12-00-00-000Z_name
 * và optional random: stamp_abc123_name
 */
export function stripPostedStampPrefix(baseName) {
  let s = String(baseName || "");
  s = s.replace(/^\d{4}-\d{2}-\d{2}T[\d\-]+Z_/i, "");
  s = s.replace(/^[a-z0-9]{4,10}_(?=\d)/i, ""); // rare random prefix before number
  return s;
}

/**
 * Stem tên media (không đuôi, không stamp posted).
 * Ví dụ: ".../1-natalie-mercer.mp4" → "1-natalie-mercer"
 */
export function mediaStemFromPath(nameOrPath) {
  const raw = String(nameOrPath || "").trim();
  if (!raw) return "";
  const base = path.basename(raw, path.extname(raw));
  return stripPostedStampPrefix(base).trim();
}

/**
 * Lấy slug cuối từ URL: https://host/1-natalie-mercer/ → "1-natalie-mercer"
 */
export function extractUrlSlug(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const parts = u.pathname.split("/").filter(Boolean);
    if (!parts.length) return "";
    return decodeURIComponent(parts[parts.length - 1]).trim();
  } catch {
    const m = raw.match(/\/([^/?#]+)\/?(?:[?#].*)?$/);
    return m ? decodeURIComponent(m[1]).trim() : "";
  }
}

/**
 * Số đầu trong slug/tên: "1-natalie-mercer" → 1, "03.tamara" → 3
 * @returns {number|null}
 */
export function extractLeadingNumber(text) {
  const s = String(text || "").trim();
  const m = s.match(/^0*(\d{1,4})(?=[.\-_)\s]|$)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Lấy số thứ tự từ tên file/media (sau khi bỏ stamp posted).
 * @returns {number|null} 1-based ordinal
 */
export function extractOrdinalFromName(nameOrPath) {
  const stem = mediaStemFromPath(nameOrPath);
  if (!stem) return null;
  return extractLeadingNumber(stem);
}

/**
 * Parse 1 dòng kho link: "1. https://..." hoặc URL thuần.
 * Gắn thêm slug + số trong path URL (không dùng số thứ tự dòng list).
 * @returns {{ ordinal: number|null, url: string, slug: string, pathNumber: number|null }|null}
 */
export function parseLinkEntry(line) {
  const raw = String(line || "").trim();
  if (!raw) return null;
  let url = null;
  let lineOrdinal = null;
  const numbered = raw.match(
    /^\s*0*(\d{1,4})\s*[.\)\-:\]]\s*((?:https?:\/\/)\S+|(?:[\w.-]+\.[a-z]{2,})\S*)/i
  );
  if (numbered) {
    lineOrdinal = Number(numbered[1]);
    url = numbered[2].trim();
  } else {
    const spaced = raw.match(
      /^\s*0*(\d{1,4})\s+((?:https?:\/\/)\S+|(?:[\w.-]+\.[a-z]{2,})\S*)/i
    );
    if (spaced) {
      lineOrdinal = Number(spaced[1]);
      url = spaced[2].trim();
    } else if (/^https?:\/\//i.test(raw) || /^[\w.-]+\.[a-z]{2,}/i.test(raw)) {
      url = raw;
    }
  }
  if (!url) return null;
  const slug = extractUrlSlug(url);
  const pathNumber = extractLeadingNumber(slug);
  // Ưu tiên số trong URL slug (1-natalie-mercer), không phải số dòng list
  const ordinal = pathNumber != null ? pathNumber : lineOrdinal;
  return { ordinal, url, slug, pathNumber, lineOrdinal };
}

/**
 * Map theo số trong URL slug (1-natalie → 1). Không gán auto theo thứ tự dòng.
 */
export function buildOrdinalLinkMap(rawLines) {
  const entries = [];
  for (const line of normalizeLineList(rawLines)) {
    const e = parseLinkEntry(line);
    if (e?.url) entries.push(e);
  }
  /** @type {Map<number, string>} */
  const map = new Map();
  /** @type {Map<string, string>} */
  const slugMap = new Map();
  for (const e of entries) {
    if (e.slug) {
      const key = e.slug.toLowerCase();
      if (!slugMap.has(key)) slugMap.set(key, e.url);
    }
    // Chỉ map khi có số trong path URL (hoặc số dòng nếu URL không có số)
    const ord = e.pathNumber != null ? e.pathNumber : e.lineOrdinal;
    if (ord != null && ord > 0 && !map.has(ord)) map.set(ord, e.url);
  }
  const urls = entries.map((e) => e.url);
  return { map, slugMap, entries, urls };
}

function normalizeKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Chọn link theo slug/số TRONG URL khớp tên media.
 * Ví dụ media "1-natalie-mercer.mp4" ↔ https://…/1-natalie-mercer/
 * KHÔNG dùng số thứ tự dòng trong list.
 */
export function pickLinkByMediaOrdinal(rawLines, mediaPathOrName) {
  const { map, slugMap, entries, urls } = buildOrdinalLinkMap(rawLines);
  const stem = mediaStemFromPath(mediaPathOrName);
  if (!stem) {
    return { url: null, ordinal: null, used_link_index: null, matched: false, reason: "no_media_name" };
  }
  const stemKey = normalizeKey(stem);
  const mediaOrd = extractLeadingNumber(stem);

  // 1) Exact slug: tên file = đoạn path URL (1-natalie-mercer)
  if (slugMap.has(stemKey)) {
    const url = slugMap.get(stemKey);
    const idx = urls.findIndex((u) => String(u).trim() === String(url).trim());
    return {
      url,
      ordinal: mediaOrd,
      used_link_index: idx >= 0 ? idx : null,
      matched: true,
      reason: "slug_exact",
      slug: stemKey,
    };
  }

  // 2) Slug chứa trong tên file hoặc ngược lại (file dài hơn / stamp còn sót)
  for (const e of entries) {
    if (!e.slug) continue;
    const sk = normalizeKey(e.slug);
    if (!sk) continue;
    if (stemKey === sk || stemKey.includes(sk) || sk.includes(stemKey)) {
      const idx = urls.findIndex((u) => String(u).trim() === String(e.url).trim());
      return {
        url: e.url,
        ordinal: e.pathNumber ?? mediaOrd,
        used_link_index: idx >= 0 ? idx : null,
        matched: true,
        reason: "slug_contains",
        slug: sk,
      };
    }
  }

  // 3) Cùng số đầu: media "1-natalie…" ↔ URL "/1-…" (theo số trong link, không theo dòng)
  if (mediaOrd != null && map.has(mediaOrd)) {
    const url = map.get(mediaOrd);
    const idx = urls.findIndex((u) => String(u).trim() === String(url).trim());
    return {
      url,
      ordinal: mediaOrd,
      used_link_index: idx >= 0 ? idx : null,
      matched: true,
      reason: "url_path_number",
      slug: extractUrlSlug(url),
    };
  }

  return {
    url: null,
    ordinal: mediaOrd,
    used_link_index: null,
    matched: false,
    reason: "no_slug_or_number_match",
    slug: stemKey,
  };
}

function pickFromList(list, mode, nextIndex) {
  if (!list.length) return { item: "", nextIndex: 0 };
  if (mode === "sequential") {
    const i = Math.abs(Number(nextIndex) || 0) % list.length;
    return { item: list[i], nextIndex: i + 1 };
  }
  const i = Math.floor(Math.random() * list.length);
  return { item: list[i], nextIndex: (Number(nextIndex) || 0) + 1 };
}

/**
 * Build comment from templates + link lists (legacy API).
 * Prefer assignCommentForPost() for per-page / per-post assignment.
 */
export function buildComment(templates, linkLists = {}, pickMode = "random") {
  const r = assignCommentForPost({
    comment_templates: templates,
    link_lists: linkLists,
    comment_pick_mode: pickMode,
  });
  return r.text;
}

/**
 * Gán comment cho **1 bài** của **1 page**.
 *
 * - Mỗi page có kho template (câu kèm) + kho link riêng.
 * - mode random: mỗi bài random 1 câu + 1 link.
 * - mode sequential (theo bài): bài 1 → dòng 1, bài 2 → dòng 2, … hết list thì xoay vòng.
 * - mode match_media: số trên tên file ảnh/video ↔ số trên dòng link (1. url / 2. url…).
 * - Câu kèm trống + có link → comment = chỉ URL.
 * - Template có {link}/{see_more}/{full_album} → thay (legacy).
 * - Template không placeholder (vd "see more :") + có link → "câu\nlink".
 *
 * cfg.media_path / cfg.media_name: dùng khi mode = match_media
 *
 * @returns {{ text: string|null, link: string|null, template: string|null, link_lists: object, used_link_index: number|null }}
 */
export function assignCommentForPost(cfg = {}) {
  const ll0 = cfg.link_lists && typeof cfg.link_lists === "object" ? { ...cfg.link_lists } : {};
  const mode = getCommentPickMode(ll0, cfg.comment_pick_mode || "random");
  const templates = normalizeLineList(cfg.comment_templates);
  // Keep raw lines (may include "1. https://...") for ordinal matching
  const rawLinkLines = (() => {
    const ll = ll0;
    const buckets = [
      ll.comment_links,
      ll.caption_lead_links,
      ll.full_album,
      ll.see_more,
    ];
    for (const b of buckets) {
      const arr = normalizeLineList(b);
      if (arr.length) return arr;
    }
    return [];
  })();
  const links = getCommentLinkPool(ll0);

  if (!templates.length && !links.length && !rawLinkLines.length) {
    return {
      text: null,
      link: null,
      template: null,
      link_lists: ll0,
      used_link_index: null,
    };
  }

  let tpl = "";
  let tplNext = Number(ll0.comment_tpl_next) || 0;
  if (templates.length) {
    // Templates: match_media → sequential by same ordinal when possible, else random
    if (mode === "match_media") {
      const mediaRef = cfg.media_path || cfg.media_name || "";
      const ord = extractOrdinalFromName(mediaRef);
      if (ord != null && templates.length) {
        const idx = Math.min(Math.max(ord - 1, 0), templates.length - 1);
        // Prefer template that starts with same number if present
        const numbered = templates.findIndex((t) => {
          const o = extractOrdinalFromName(String(t).replace(/\s+/g, " "));
          return o === ord;
        });
        tpl = templates[numbered >= 0 ? numbered : idx];
        tplNext = tplNext + 1;
      } else {
        const p = pickFromList(templates, "random", tplNext);
        tpl = p.item;
        tplNext = p.nextIndex;
      }
    } else {
      const p = pickFromList(templates, mode === "sequential" ? "sequential" : "random", tplNext);
      tpl = p.item;
      tplNext = p.nextIndex;
    }
  }

  let link = "";
  let linkNext = Number(ll0.comment_link_next) || 0;
  let usedLinkIndex = null;
  let matchMeta = null;
  if (links.length || rawLinkLines.length) {
    if (mode === "match_media") {
      const mediaRef = cfg.media_path || cfg.media_name || "";
      const picked = pickLinkByMediaOrdinal(rawLinkLines.length ? rawLinkLines : links, mediaRef);
      matchMeta = picked;
      if (picked.url) {
        link = picked.url;
        usedLinkIndex = picked.used_link_index;
        // Do not advance sequential cursor on match — pairing is by filename
      } else {
        // Fallback sequential so comment vẫn có link (tránh mất comment)
        const start = Math.abs(Number(ll0.comment_link_next) || 0) % Math.max(links.length, 1);
        const p = pickFromList(links, "sequential", linkNext);
        link = p.item;
        linkNext = p.nextIndex;
        usedLinkIndex = links.length ? start : null;
        console.warn(
          `[assignCommentForPost] match_media miss (${picked.reason || "?"}) media=${mediaRef} → fallback sequential`
        );
      }
    } else {
      const start = Math.abs(Number(ll0.comment_link_next) || 0) % links.length;
      const p = pickFromList(links, mode, linkNext);
      link = p.item;
      linkNext = p.nextIndex;
      usedLinkIndex = mode === "sequential" ? start : links.indexOf(link);
    }
  }

  // Keyed lists still support {see_more} / {full_album} independently if set
  const pickKey = (key) => {
    const arr = normalizeLineList(ll0[key]);
    if (!arr.length) return link || "";
    if (mode === "sequential") {
      const i = Math.abs(Number(ll0.comment_link_next) || 0) % arr.length;
      return arr[i];
    }
    return arr[Math.floor(Math.random() * arr.length)];
  };

  let text = "";
  if (tpl) {
    const hasPh =
      /\{see_more\}|\{full_album\}|\{link\}|\{link:[a-zA-Z0-9_]+\}/.test(tpl);
    text = tpl
      .replace(/\{link:([a-zA-Z0-9_]+)\}/g, (_, key) => pickKey(key) || link || "")
      .replace(/\{see_more\}/g, () => pickKey("see_more") || link || "")
      .replace(/\{full_album\}/g, () => pickKey("full_album") || link || "")
      .replace(/\{link\}/g, () => link || pickKey("see_more") || pickKey("full_album") || "");
    // Luôn ghép URL nếu template không chứa link (vd "see more :") — tránh comment không có URL
    if (link && !text.includes(link)) {
      text = `${text.trim()}\n${link}`.trim();
    } else if (!link && hasPh) {
      // placeholder rỗng → bỏ dòng trống thừa
      text = text.replace(/\n{2,}/g, "\n").trim();
    }
  } else if (link) {
    text = link;
  }

  // Template kiểu "see more :" mà không có link nào trong kho → null (đừng comment rỗng ý nghĩa)
  text = String(text || "").trim() || null;
  if (text && !link && !/https?:\/\//i.test(text)) {
    // Chỉ câu mẫu, không URL — vẫn cho gửi (user có thể chỉ muốn text),
    // nhưng ghi log để debug bulk
    console.warn(
      "[assignCommentForPost] comment không có URL — kho link trống (comment_links / caption_lead_links)"
    );
  }

  const link_lists = {
    ...ll0,
    comment_link_mode: mode,
    comment_tpl_next: tplNext,
    comment_link_next: linkNext,
    // Keep primary pool for UI (if only full_album/see_more existed, leave them)
    comment_links:
      Array.isArray(ll0.comment_links) && ll0.comment_links.length
        ? ll0.comment_links
        : links.length
          ? links
          : ll0.comment_links || [],
  };

  return {
    text,
    link: link || null,
    template: tpl || null,
    link_lists,
    used_link_index: usedLinkIndex,
    mode,
    media_ordinal: matchMeta?.ordinal ?? extractOrdinalFromName(cfg.media_path || cfg.media_name || "") ?? null,
    match_reason: matchMeta?.reason || null,
  };
}
