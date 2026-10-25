import fs from "fs";
import path from "path";

const IMAGE_EXT = /\.(jpe?g|png|gif|bmp|webp|tiff?)$/i;
const VIDEO_EXT = /\.(mp4|mov|avi|mkv|webm|m4v)$/i;

export function ensureDir(dir) {
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
}

const missingRoots = new Set();

function folderReadable(folder) {
  if (!folder) return false;
  let root = "";
  try {
    root = path.parse(path.resolve(String(folder))).root.toLowerCase();
  } catch {
    return false;
  }
  if (root && missingRoots.has(root)) return false;
  try {
    if (root && !fs.existsSync(root)) {
      missingRoots.add(root);
      return false;
    }
  } catch {
    if (root) missingRoots.add(root);
    return false;
  }
  try {
    return fs.existsSync(folder);
  } catch {
    return false;
  }
}

export function listMediaFiles(folder, kind = "any") {
  if (!folderReadable(folder)) return [];
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
/** Dòng trong folder. File `4.txt` / `4-mo-dau.txt` mà nội dung không có số đầu → gắn `4. ` để khớp media. Chỉ Theo bộ. */
export function loadNumberedFolderLines(folderPath) {
  if (!folderPath || !String(folderPath).trim()) return [];
  const p = path.resolve(String(folderPath).trim());
  if (!fs.existsSync(p)) return [];
  const files = [];
  const st = fs.statSync(p);
  if (st.isFile()) files.push(p);
  else if (st.isDirectory()) {
    for (const name of fs.readdirSync(p)) {
      if (/\.(txt|csv)$/i.test(name)) files.push(path.join(p, name));
    }
    files.sort();
  }
  const out = [];
  for (const file of files) {
    const ord = extractOrdinalFromName(file);
    const lines = loadCaptionsFromDisk(file, { bundleNumbers: true });
    for (const line of lines) {
      const t = String(line || "").trim();
      if (!t) continue;
      if (ord != null && extractLeadingNumber(t) == null) out.push(`${ord}. ${t}`);
      else out.push(t);
    }
  }
  return out;
}

/**
 * @param {string} captionsPath
 * @param {{ bundleNumbers?: boolean }} [opts]
 * bundleNumbers: chỉ Theo bộ. Gắn số tên file và nối dòng không số vào caption phía trên.
 * Mặc định (hẹn giờ / đăng trực tiếp): mỗi dòng không trống là một caption, không bắt đánh số.
 */
export function loadCaptionsFromDisk(captionsPath, opts = {}) {
  if (!captionsPath || !String(captionsPath).trim()) return [];
  const p = path.resolve(String(captionsPath).trim());
  if (!fs.existsSync(p)) return [];
  const bundleNumbers = !!opts.bundleNumbers;

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
    const fileOrd = extractOrdinalFromName(file);
    const parsed = /\.csv$/i.test(file)
      ? parseCaptionsCsv(text)
      : parseCaptionsTxt(text, { bundleNumbers });
    for (const line of parsed) {
      const t = String(line || "").trim();
      if (!t) continue;
      if (bundleNumbers && fileOrd != null && extractLeadingNumber(t) == null) out.push(`${fileOrd}. ${t}`);
      else out.push(t);
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

function parseCaptionsTxt(text, opts = {}) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (!opts.bundleNumbers) return lines;
  const out = [];
  for (const line of lines) {
    if (extractLeadingNumber(line) != null || !out.length) out.push(line);
    else out[out.length - 1] += "\n" + line;
  }
  return out;
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
 * pickMode: random | sequential | sequential_shuffle | match_media
 * match_media: số đầu tên media (14-sad-news….mp4) ↔ số đầu dòng caption (14. SAD NEWS…)
 *
 * @param {string[]} [exclude] captions to skip (already tried / blocked as dup)
 * @param {string} [mediaPathOrName] required for match_media
 */
export function pickCaption(
  captions,
  slotIndex = 0,
  pickMode = "random",
  captionsFolder = "",
  exclude = [],
  mediaPathOrName = ""
) {
  const mode = String(pickMode || "").toLowerCase();
  const fromDisk = loadCaptionsFromDisk(captionsFolder, {
    bundleNumbers: mode === "match_media",
  });
  const inline = Array.isArray(captions)
    ? captions.map((c) => String(c).trim()).filter(Boolean)
    : [];
  // Disk first (kho), then inline extras
  let list = [...fromDisk, ...inline.filter((c) => !fromDisk.includes(c))];
  if (!list.length) return "";
  const mediaOrdEarly = mediaPathOrName ? extractOrdinalFromName(mediaPathOrName) : null;
  if (mode === "match_media" && mediaOrdEarly != null) {
    const matched = pickCaptionByMediaOrdinal(list, mediaPathOrName, exclude);
    if (matched.caption) return matched.caption;
    console.warn(
      `[pickCaption] thiếu caption số ${mediaOrdEarly} (${mediaPathOrName}) → không lấy caption khác`
    );
    return "";
  }

  // Default / fallback:
  // - cycle 0: preserve the source order from beginning to end;
  // - later cycles: use a stable shuffled order, so restart/retry does not
  //   unexpectedly change the caption assigned to a slot.
  const index = Math.max(0, Number(slotIndex) || 0);
  const cycle = Math.floor(index / list.length);
  const offset = index % list.length;
  const ordered =
    mode === "random"
      ? stableShuffle(list, (index % 997) + 1)
      : captionOrderForCycle(list, cycle);
  const ban = new Set((exclude || []).map((c) => String(c).trim().toLowerCase()));
  for (let step = 0; step < ordered.length; step++) {
    const candidate = ordered[(offset + step) % ordered.length];
    if (!ban.has(String(candidate).trim().toLowerCase())) return candidate;
  }
  return "";
}

/**
 * Caption khớp media theo số đầu:
 *   14-sad-news-….mp4  ↔  "14. SAD NEWS !!! …"
 * @returns {{ caption: string|null, ordinal: number|null, matched: boolean, used_index: number|null, reason: string }}
 */
export function pickCaptionByMediaOrdinal(list, mediaPathOrName, exclude = []) {
  const ban = new Set((exclude || []).map((c) => String(c).trim().toLowerCase()));
  const mediaOrd = extractOrdinalFromName(mediaPathOrName);
  if (mediaOrd == null) {
    return {
      caption: null,
      ordinal: null,
      matched: false,
      used_index: null,
      reason: "no_media_ordinal",
    };
  }
  const arr = Array.isArray(list) ? list : [];
  for (let i = 0; i < arr.length; i++) {
    const c = String(arr[i] || "").trim();
    if (!c) continue;
    if (ban.has(c.toLowerCase())) continue;
    const ord = extractLeadingNumber(c);
    if (ord === mediaOrd) {
      return {
        caption: c,
        ordinal: mediaOrd,
        matched: true,
        used_index: i,
        reason: "ordinal_exact",
      };
    }
  }
  return {
    caption: null,
    ordinal: mediaOrd,
    matched: false,
    used_index: null,
    reason: "ordinal_miss",
  };
}

/** Normalize pick_mode from page config */
export function getCaptionPickMode(cfg = {}, fallback = "sequential_shuffle") {
  const m = String(cfg?.pick_mode || cfg?.link_lists?.caption_pick_mode || fallback)
    .trim()
    .toLowerCase();
  if (m === "match_media" || m === "match_ordinal" || m === "by_media") return "match_media";
  if (m === "sequential") return "sequential";
  if (m === "random") return "random";
  return "sequential_shuffle";
}

/**
 * Hẹn giờ và đăng trực tiếp không khớp số.
 * pick_mode match_media còn lưu từ tab Theo bộ bị bỏ qua.
 * Sequential giữ lần lượt. Còn lại là random.
 */
export function captionModeForRun(cfg = {}, opts = {}) {
  if (opts.match_bundle) return "match_media";
  const stored = getCaptionPickMode(cfg, "random");
  return stored === "sequential" ? "sequential" : "random";
}

/** Chỉ tab Theo bộ được chặn khi thiếu caption đúng số. Đăng trực tiếp / hẹn giờ đăng tiếp. */
export function bundleCaptionGapMessage(matchBundle, mediaPathOrName) {
  if (!matchBundle) return null;
  const ord = extractOrdinalFromName(mediaPathOrName || "");
  if (ord == null) return null;
  return `Thiếu caption số ${ord}. Không lấy caption số khác. Không đăng khi bộ không đủ.`;
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
 * Link dòng mở đầu CAPTION — chỉ kho caption_lead_links.
 * Không lấy comment_links (link comment không được gắn vào caption).
 */
export function getCaptionLeadLinkPool(linkLists = {}) {
  const ll = linkLists && typeof linkLists === "object" ? linkLists : {};
  return normalizeLineList(ll.caption_lead_links);
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
 * Link: chỉ caption_lead_links (không dùng kho link comment)
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
  // Mode dòng mở đầu riêng — không lấy comment_link_mode (tránh random lead bị thành khớp/link đầu)
  const mode = getCommentPickMode(
    { comment_link_mode: ll0.caption_lead_mode || "random" },
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
        const numbered = templates.findIndex((t) => extractLeadingNumber(t) === ord || extractOrdinalFromName(t) === ord);
        if (numbered < 0) {
          tpl = "";
        } else {
          tpl = templates[numbered];
          tplNext += 1;
        }
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
      const raw = normalizeLineList(ll0.caption_lead_links);
      const picked = pickLinkByMediaOrdinal(raw, mediaRef);
      if (picked.url) {
        link = picked.url;
      } else {
        link = "";
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
 * Kho link COMMENT — không lấy link dòng mở đầu caption.
 * comment_links trước, rồi full_album / see_more nếu đó là kho comment cũ.
 */
/** Theo bộ: split = câu và ô link riêng. merged = câu mở đầu đã kèm URL. */
export function commentBundleMode(linkLists = {}) {
  const m = String(linkLists?.comment_bundle_mode || "split").trim().toLowerCase();
  return m === "merged" ? "merged" : "split";
}

function bundleOpenerOnly(linkLists = {}) {
  const mode = getCommentPickMode(linkLists, "random");
  const ll = linkLists && typeof linkLists === "object" ? linkLists : {};
  const withLink =
    ll.comment_with_link === true ||
    ll.comment_with_link === 1 ||
    ll.comment_with_link === "1" ||
    String(ll.comment_with_link || "").toLowerCase() === "on";
  return mode === "match_media" && !withLink;
}

/** Hẹn giờ / đăng trực tiếp: câu kèm phải có link. Theo bộ không tick kèm link thì giữ nguyên câu mở đầu. */
export function ensureCommentHasLink(text, linkLists = {}, opts = {}) {
  if (!opts.force && bundleOpenerOnly(linkLists)) {
    const body = String(text || "").trim();
    return body || null;
  }
  const body = String(text || "").trim();
  if (/https?:\/\//i.test(body)) return body;
  const pool = getCommentLinkPool(linkLists);
  if (!pool.length) return body || null;
  const link = pool[Math.floor(Math.random() * pool.length)];
  return body ? `${body}\n${link}` : link;
}

export function getCommentLinkPool(linkLists = {}) {
  const ll = linkLists && typeof linkLists === "object" ? linkLists : {};
  const buckets = [
    normalizeLineList(ll.comment_links),
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
 * Site = hostname của link (bỏ www.).
 * Ví dụ: https://profiles.dailypulsepost.com/1-natalie/ → profiles.dailypulsepost.com
 */
export function extractCommentSite(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return String(u.hostname || "")
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    const m = raw.match(/^(?:https?:\/\/)?([^/?#]+)/i);
    return m
      ? String(m[1])
          .toLowerCase()
          .replace(/^www\./, "")
      : "";
  }
}

/**
 * Ngân sách: mỗi site (domain) chỉ được comment trên tối đa N page (unique page_row_id).
 * Dùng chung trong 1 job / 1 phiên chạy.
 */
export function createCommentSiteTracker(maxPagesPerSite = 10) {
  const max = Math.max(0, Number(maxPagesPerSite) || 0);
  /** @type {Map<string, Set<number>>} */
  const siteToPages = new Map();
  return {
    maxPagesPerSite: max,
    /** Site còn chỗ cho page này? (page đã dùng site trước đó vẫn OK) */
    canUse(site, pageRowId) {
      if (!max || !site) return true;
      const id = Number(pageRowId) || 0;
      const set = siteToPages.get(site);
      if (!set) return true;
      if (set.has(id)) return true;
      return set.size < max;
    },
    /** Ghi nhận page đã comment bằng link thuộc site */
    record(site, pageRowId) {
      if (!max || !site) return;
      const id = Number(pageRowId) || 0;
      if (!id) return;
      if (!siteToPages.has(site)) siteToPages.set(site, new Set());
      siteToPages.get(site).add(id);
    },
    count(site) {
      return siteToPages.get(site)?.size || 0;
    },
    snapshot() {
      const out = {};
      for (const [s, set] of siteToPages) out[s] = set.size;
      return out;
    },
  };
}

export function getCommentMaxPagesPerSite(linkLists = {}, fallback = 0) {
  // Explicit 0 / thiếu field = TẮT anti site (comment bình thường mọi page).
  // Chỉ giới hạn khi user bật và set N > 0.
  if (
    Object.prototype.hasOwnProperty.call(linkLists || {}, "comment_max_pages_per_site") ||
    Object.prototype.hasOwnProperty.call(linkLists || {}, "max_pages_per_site")
  ) {
    const raw =
      linkLists.comment_max_pages_per_site ?? linkLists.max_pages_per_site;
    const n = Number(raw);
    if (!Number.isFinite(n)) return Math.max(0, Number(fallback) || 0);
    return Math.max(0, Math.min(500, n));
  }
  const n = Number(fallback);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(500, n));
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
 * Tìm lại file media nếu path cache đã mất (job khác đã move → posted / đổi tên stamp).
 * VD: kho_video\14-foo.mp4 → posted\2026-…Z_14-foo.mp4
 */
export function resolveExistingMediaPath(filePath, extraFolders = []) {
  if (!filePath) return null;
  const abs = path.resolve(String(filePath));
  if (fs.existsSync(abs)) return abs;
  const base = path.basename(abs);
  const stem = mediaStemFromPath(base) || base.replace(/\.[^.]+$/, "");
  const dirs = [
    path.dirname(abs),
    ...extraFolders.map((d) => (d ? path.resolve(String(d)) : null)).filter(Boolean),
  ];
  const seen = new Set();
  for (const dir of dirs) {
    const key = String(dir).toLowerCase();
    if (seen.has(key) || !fs.existsSync(dir)) continue;
    seen.add(key);
    try {
      const names = fs.readdirSync(dir);
      if (names.includes(base)) return path.join(dir, base);
      const hit = names.find((n) => {
        if (n === base) return true;
        if (n.endsWith(`_${base}`)) return true;
        const ns = mediaStemFromPath(n);
        return Boolean(ns && stem && (ns === stem || ns.endsWith(`_${stem}`) || stem.endsWith(ns)));
      });
      if (hit) return path.join(dir, hit);
    } catch {
      /* */
    }
  }
  return null;
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
 * Khớp bộ bắt buộc: media + caption + link + mở đầu comment cùng một số.
 * Thiếu hoặc lệch số → throw, không đăng.
 */
export function assertMatchedBundle({ mediaPath, caption, cfg = {} } = {}) {
  const base = mediaPath ? path.basename(String(mediaPath)) : "";
  const mediaOrd = extractOrdinalFromName(mediaPath || "");
  const problems = [];

  if (!mediaPath) problems.push("Media: thiếu file");
  else if (mediaOrd == null) problems.push(`Media: «${base}» không có số đầu tên (vd 4-ten.mp4)`);

  const capLine = String(caption || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) || "";
  const capOrd = extractLeadingNumber(capLine);
  if (!capLine) problems.push(`Caption: thiếu dòng số ${mediaOrd ?? "?"}`);
  else if (mediaOrd != null && capOrd !== mediaOrd) {
    problems.push(`Caption: số ${capOrd ?? "không có"} («${capLine.slice(0, 60)}») không trùng media số ${mediaOrd}`);
  }

  const ll = cfg.link_lists && typeof cfg.link_lists === "object" ? cfg.link_lists : {};
  const bundleMode = commentBundleMode(ll);
  const withLink =
    ll.comment_with_link === true ||
    ll.comment_with_link === 1 ||
    ll.comment_with_link === "1" ||
    String(ll.comment_with_link || "").toLowerCase() === "on";
  const openFolder = String(ll.comment_open_folder || cfg.comment_open_folder || "").trim();
  let openerHit = null;
  if (!openFolder) {
    problems.push("Mở đầu comment: chưa chọn folder kho");
  } else {
    const lines = loadNumberedFolderLines(openFolder);
    openerHit = pickCommentTemplateByMediaOrdinal(lines, mediaPath || "");
    if (!openerHit.matched) {
      problems.push(`Mở đầu comment: thiếu số ${mediaOrd ?? "?"} trong ${openFolder}`);
    }
  }

  if (bundleMode === "merged") {
    if (openerHit?.matched && !String(openerHit.url || "").trim()) {
      problems.push(
        `Bộ số ${mediaOrd ?? "?"}: comment chưa kèm link. Không đăng khi chưa có link đúng bộ.`
      );
    }
  } else if (withLink) {
    const rawLinks = normalizeLineList(ll.comment_links).length
      ? normalizeLineList(ll.comment_links)
      : normalizeLineList(ll.full_album);
    if (!rawLinks.length) {
      problems.push(
        `Đã bật gắn link đúng bộ nhưng kho link không có bộ số ${mediaOrd ?? "?"}. Không đăng.`
      );
    } else {
      const picked = pickLinkByMediaOrdinal(rawLinks, mediaPath || "");
      if (!picked?.url) {
        problems.push(
          `Đã bật gắn link đúng bộ nhưng không có link trùng số ${mediaOrd ?? "?"}. Không đăng.`
        );
      } else if (
        mediaOrd != null &&
        picked.ordinal != null &&
        Number(picked.ordinal) !== mediaOrd &&
        picked.reason !== "line_ordinal" &&
        picked.reason !== "line_ordinal_first" &&
        picked.reason !== "ordinal_map"
      ) {
        problems.push(`Link số ${picked.ordinal} không trùng bộ số ${mediaOrd}. Không đăng.`);
      }
    }
  }

  if (!problems.length) return;
  throw new Error(
    `Không trùng khớp bộ${mediaOrd != null ? " số " + mediaOrd : ""}${base ? " · " + base : ""}:\n- ${problems.join("\n- ")}`
  );
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
  // Số ghi đầu dòng là số bộ. Số trong URL chỉ dùng khi dòng không ghi số.
  const ordinal = lineOrdinal != null ? lineOrdinal : pathNumber;
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
    const ord = e.lineOrdinal != null ? e.lineOrdinal : e.pathNumber;
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

/** ID dài trong tên file (FB reel/post id), vd 5-1583681133509093.mp4 → 1583681133509093 */
export function extractLongIdsFromMediaName(nameOrPath) {
  const stem = mediaStemFromPath(nameOrPath) || String(nameOrPath || "");
  const ids = [];
  const re = /(\d{8,})/g;
  let m;
  while ((m = re.exec(stem))) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

/**
 * Chọn link theo:
 * 1) Facebook reel/post ID trong tên media ↔ URL chứa ID đó
 * 2) slug path (1-natalie-mercer)
 * 3) số đầu dòng list (9. https://…)
 * 4) post_round → phần tử thứ N trong list (khi URL không đánh số)
 */
export function pickLinkByMediaOrdinal(rawLines, mediaPathOrName, opts = {}) {
  const { map, slugMap, entries, urls } = buildOrdinalLinkMap(rawLines);
  const stem = mediaStemFromPath(mediaPathOrName);
  const postRound = Math.max(0, Number(opts.postRound) || 0);
  if (!stem && !postRound) {
    return { url: null, ordinal: null, used_link_index: null, matched: false, reason: "no_media_name" };
  }
  const stemKey = normalizeKey(stem || "");
  const mediaOrd = stem ? extractLeadingNumber(stem) : null;

  // 0) Facebook ID trong tên file ↔ URL (reel/1376… hoặc dailyscope/… ít gặp)
  if (stem) {
    const fbIds = extractLongIdsFromMediaName(stem);
    for (const id of fbIds) {
      const hit = entries.find((e) => String(e.url || "").includes(id));
      if (hit) {
        const idx = urls.findIndex((u) => String(u).trim() === String(hit.url).trim());
        return {
          url: hit.url,
          ordinal: mediaOrd,
          used_link_index: idx >= 0 ? idx : null,
          matched: true,
          reason: "facebook_id_in_filename",
          slug: hit.slug,
          facebook_id: id,
        };
      }
    }
  }

  // 1) Exact slug: tên file = đoạn path URL (1-natalie-mercer)
  if (stemKey && slugMap.has(stemKey)) {
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

  // Số ghi đầu dòng thắng trước slug/URL. "1. https://…/1100-videos" vẫn là bộ 1.
  if (mediaOrd != null) {
    const byLineEarly = entries.filter((e) => e.lineOrdinal === mediaOrd);
    if (byLineEarly.length) {
      const e = byLineEarly[0];
      const idx = urls.findIndex((u) => String(u).trim() === String(e.url).trim());
      return {
        url: e.url,
        ordinal: mediaOrd,
        used_link_index: idx >= 0 ? idx : null,
        matched: true,
        reason: byLineEarly.length > 1 ? "line_ordinal_first" : "line_ordinal",
        slug: e.slug,
      };
    }
  }

  // 2) Slug chứa trong tên file hoặc ngược lại (file dài hơn / stamp còn sót)
  for (const e of entries) {
    if (!e.slug) continue;
    const sk = normalizeKey(e.slug);
    if (!sk || sk.length < 8) continue;
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

  // 3) Cùng số đầu trong URL path — nếu NHIỀU site cùng số, chọn slug gần tên file nhất.
  //    Ví dụ media "1-natalie-mercer" vs siteA/1-natalie-mercer + siteB/1-other → chọn A.
  if (mediaOrd != null) {
    const candidates = entries.filter(
      (e) =>
        e.pathNumber === mediaOrd &&
        (e.lineOrdinal == null || e.lineOrdinal === e.pathNumber)
    );
    if (candidates.length === 1) {
      const e = candidates[0];
      const idx = urls.findIndex((u) => String(u).trim() === String(e.url).trim());
      return {
        url: e.url,
        ordinal: mediaOrd,
        used_link_index: idx >= 0 ? idx : null,
        matched: true,
        reason: "url_path_number",
        slug: e.slug,
      };
    }
    if (candidates.length > 1) {
      let best = null;
      let bestScore = -1;
      for (const e of candidates) {
        const sk = normalizeKey(e.slug);
        let score = 0;
        if (stemKey === sk) score = 100;
        else if (stemKey.includes(sk) || sk.includes(stemKey)) score = 80;
        else {
          // token overlap (natalie, mercer…)
          const a = new Set(stemKey.split("-").filter((t) => t && t !== String(mediaOrd)));
          const b = sk.split("-").filter((t) => t && t !== String(mediaOrd));
          const hit = b.filter((t) => a.has(t)).length;
          score = hit * 10;
        }
        if (score > bestScore) {
          bestScore = score;
          best = e;
        }
      }
      if (best && bestScore > 0) {
        const idx = urls.findIndex((u) => String(u).trim() === String(best.url).trim());
        return {
          url: best.url,
          ordinal: mediaOrd,
          used_link_index: idx >= 0 ? idx : null,
          matched: true,
          reason: "url_path_number_best_slug",
          slug: best.slug,
        };
      }
      // Nhiều site cùng số, không phân biệt được theo tên → bỏ (tránh gắn nhầm site)
      return {
        url: null,
        ordinal: mediaOrd,
        used_link_index: null,
        matched: false,
        reason: "ambiguous_same_number_multi_site",
        slug: stemKey,
      };
    }

    // 4) Số đầu DÒNG list: "9. https://dailyscope…/9Zvzpa" (URL không có số sạch trong path)
    const byLine = entries.filter((e) => e.lineOrdinal === mediaOrd);
    if (byLine.length === 1) {
      const e = byLine[0];
      const idx = urls.findIndex((u) => String(u).trim() === String(e.url).trim());
      return {
        url: e.url,
        ordinal: mediaOrd,
        used_link_index: idx >= 0 ? idx : null,
        matched: true,
        reason: "line_ordinal",
        slug: e.slug,
      };
    }
    if (byLine.length > 1) {
      // Nhiều dòng cùng số — lấy dòng đầu (ổn định)
      const e = byLine[0];
      const idx = urls.findIndex((u) => String(u).trim() === String(e.url).trim());
      return {
        url: e.url,
        ordinal: mediaOrd,
        used_link_index: idx >= 0 ? idx : null,
        matched: true,
        reason: "line_ordinal_first",
        slug: e.slug,
      };
    }
    // map từ buildOrdinalLinkMap (lineOrdinal hoặc pathNumber)
    if (map.has(mediaOrd)) {
      const url = map.get(mediaOrd);
      const idx = urls.findIndex((u) => String(u).trim() === String(url).trim());
      return {
        url,
        ordinal: mediaOrd,
        used_link_index: idx >= 0 ? idx : null,
        matched: true,
        reason: "ordinal_map",
        slug: stemKey,
      };
    }
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

/**
 * Parse dòng câu kèm: "9. Critics …" hoặc "9. Critics … https://…"
 * @returns {{ ordinal: number|null, text: string, url: string, raw: string }}
 */
export function parseNumberedCommentTemplate(line) {
  const raw = String(line || "").trim();
  if (!raw) return { ordinal: null, text: "", url: "", raw: "" };
  const ord = extractLeadingNumber(raw);
  const urlMatch = raw.match(/(https?:\/\/\S+)/i);
  const url = urlMatch ? urlMatch[1].replace(/[.,;:!?)]+$/, "") : "";
  let text = raw;
  if (url) text = text.replace(urlMatch[0], "").trim();
  // Bỏ tiền tố số "9." / "9)" khi gửi comment (giữ câu sạch)
  text = text.replace(/^\s*0*\d{1,4}\s*[.\)\-:\]]\s*/, "").trim();
  return { ordinal: ord, text: text || raw, url, raw };
}

/**
 * Chọn câu kèm theo số media (giống link).
 */
export function pickCommentTemplateByMediaOrdinal(templates, mediaPathOrName) {
  const list = normalizeLineList(templates);
  const mediaOrd = extractOrdinalFromName(mediaPathOrName);
  if (mediaOrd == null || !list.length) {
    return { template: "", text: "", url: "", ordinal: mediaOrd, matched: false, reason: "no_ordinal_or_empty" };
  }
  for (const line of list) {
    const parsed = parseNumberedCommentTemplate(line);
    if (parsed.ordinal === mediaOrd) {
      return {
        template: line,
        text: parsed.text,
        url: parsed.url,
        ordinal: mediaOrd,
        matched: true,
        reason: "template_ordinal",
      };
    }
  }
  // Fallback index 0-based (ord-1) nếu không có dòng đánh số
  const idx = Math.min(Math.max(mediaOrd - 1, 0), list.length - 1);
  const line = list[idx];
  const parsed = parseNumberedCommentTemplate(line);
  return {
    template: line,
    text: parsed.text || line,
    url: parsed.url,
    ordinal: mediaOrd,
    matched: false,
    reason: "template_index_fallback",
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
 * Mode hẹn giờ / đăng thường (random hoặc lần lượt).
 * Tách khỏi Theo bộ: không đọc comment_open_folder, comment_with_link, match_media.
 * Luôn ghép 1 câu trong comment_templates với 1 link trong kho comment.
 * Không ghi đè comment_link_mode / folder / cờ kèm link của page.
 */
function assignClassicComment(cfg = {}) {
  const ll0 = cfg.link_lists && typeof cfg.link_lists === "object" ? { ...cfg.link_lists } : {};
  const stored = getCommentPickMode(ll0, cfg.comment_pick_mode || "random");
  const mode = stored === "sequential" ? "sequential" : "random";
  const templates = normalizeLineList(cfg.comment_templates);
  const pageRowId = Number(cfg.page_row_id) || 0;
  const siteTracker = cfg.comment_site_tracker || null;
  const maxPagesPerSite =
    siteTracker?.maxPagesPerSite ?? getCommentMaxPagesPerSite(ll0, 0);
  const linkSiteOk = (url) => {
    if (!siteTracker || !maxPagesPerSite) return true;
    const site = extractCommentSite(url);
    if (!site) return true;
    return siteTracker.canUse(site, pageRowId);
  };
  const pickAllowedFallback = (pool, nextIdx, pickMode = "random") => {
    const allowed = (pool || []).filter((u) => linkSiteOk(u));
    if (!allowed.length) {
      return { link: "", linkNext: nextIdx, usedLinkIndex: null, siteSkipReason: "all_sites_at_cap" };
    }
    const start = Math.abs(Number(nextIdx) || 0) % allowed.length;
    const p = pickFromList(allowed, pickMode === "sequential" ? "sequential" : "random", nextIdx);
    return {
      link: p.item,
      linkNext: p.nextIndex,
      usedLinkIndex: pickMode === "sequential" ? start : allowed.indexOf(p.item),
      siteSkipReason: null,
    };
  };
  const links = getCommentLinkPool(ll0);
  if (!templates.length && !links.length) {
    return {
      text: null,
      link: null,
      template: null,
      link_lists: ll0,
      used_link_index: null,
      mode,
      comment_style: "classic",
    };
  }

  let tpl = "";
  let tplText = "";
  let tplEmbeddedUrl = "";
  let tplNext = Number(ll0.comment_tpl_next) || 0;
  if (templates.length) {
    const p = pickFromList(templates, mode, tplNext);
    tpl = p.item;
    const parsed = parseNumberedCommentTemplate(tpl);
    tplText = parsed.url ? parsed.text : tpl;
    tplEmbeddedUrl = parsed.url || "";
    tplNext = p.nextIndex;
  }

  let link = "";
  let linkNext = Number(ll0.comment_link_next) || 0;
  let usedLinkIndex = null;
  let siteSkipReason = null;
  if (tplEmbeddedUrl && linkSiteOk(tplEmbeddedUrl)) {
    link = tplEmbeddedUrl;
  } else if (links.length) {
    const fb = pickAllowedFallback(links, linkNext, mode);
    if (!fb.link) {
      link = "";
      usedLinkIndex = null;
      siteSkipReason = fb.siteSkipReason || "all_sites_at_cap";
    } else {
      link = fb.link;
      linkNext = fb.linkNext;
      usedLinkIndex = fb.usedLinkIndex;
    }
  }

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
  const bodyTpl = (tplText || tpl || "").trim();
  if (bodyTpl) {
    text = bodyTpl
      .replace(/\{link:([a-zA-Z0-9_]+)\}/g, (_, key) => pickKey(key) || link || "")
      .replace(/\{see_more\}/g, () => pickKey("see_more") || link || "")
      .replace(/\{full_album\}/g, () => pickKey("full_album") || link || "")
      .replace(/\{link\}/g, () => link || pickKey("see_more") || pickKey("full_album") || "");
    if (link && !text.includes(link)) text = `${text.trim()}\n${link}`.trim();
  } else if (link) {
    text = link;
  }
  text = String(text || "").trim() || null;
  if (siteSkipReason && !link) text = null;
  if (!siteSkipReason) text = ensureCommentHasLink(text, ll0, { force: true });

  const usedSite = link ? extractCommentSite(link) : "";
  if (text && link && siteTracker && usedSite) siteTracker.record(usedSite, pageRowId);

  return {
    text,
    link: link || null,
    template: tpl || null,
    link_lists: {
      ...ll0,
      comment_tpl_next: tplNext,
      comment_link_next: linkNext,
      comment_max_pages_per_site: maxPagesPerSite,
    },
    used_link_index: usedLinkIndex,
    mode,
    comment_style: "classic",
    media_ordinal: null,
    match_reason: siteSkipReason || null,
    comment_site: usedSite || null,
    site_page_count: usedSite && siteTracker ? siteTracker.count(usedSite) : null,
  };
}

/**
 * Gán comment cho **1 bài** của **1 page**.
 *
 * comment_style "classic" → assignClassicComment (random/lần lượt, luôn có link).
 * Còn lại (kể cả "bundle") giữ nguyên nhánh khớp số bên dưới — không đổi thuật toán Theo bộ.
 *
 * - Mỗi page có kho template (câu kèm) + kho link riêng.
 * - mode random: mỗi bài random 1 câu + 1 link.
 * - mode sequential (theo bài): bài 1 → dòng 1, bài 2 → dòng 2, … hết list thì xoay vòng.
 * - mode match_media: ưu tiên URL khớp slug/số tên file; không khớp (hoặc site đã đủ N page)
 *   → lấy link khác còn slot (không để comment trống URL). Chỉ bỏ comment khi mọi site đã đủ cap.
 * - Câu kèm trống + có link → comment = chỉ URL.
 * - Template có {link}/{see_more}/{full_album} → thay (legacy).
 * - Template không placeholder (vd "see more :") + có link → "câu\nlink".
 *
 * cfg.media_path / cfg.media_name: dùng khi mode = match_media
 * cfg.page_row_id + cfg.comment_site_tracker: giới hạn tối đa N page / site (domain)
 *
 * Mode gộp: câu mở đầu đã có URL cùng số. Không đọc ô link riêng.
 * Thiếu URL đúng số → text null, match_reason merged_missing_link. assertMatchedBundle chặn trước khi đăng.
 */
function assignMergedBundleComment(cfg, ll0) {
  const openFolder = String(ll0.comment_open_folder || cfg.comment_open_folder || "").trim();
  const fromFolder = loadNumberedFolderLines(openFolder);
  const templates = fromFolder.length ? fromFolder : normalizeLineList(cfg.comment_templates);
  const mediaRef = cfg.media_path || cfg.media_name || "";
  const picked = pickCommentTemplateByMediaOrdinal(templates, mediaRef);
  const url = picked.matched ? String(picked.url || "").trim() : "";
  const sentence = picked.matched ? String(picked.text || "").trim() : "";
  const text = url
    ? sentence && !sentence.includes(url)
      ? `${sentence}\n${url}`
      : sentence || url
    : null;
  return {
    text,
    link: url || null,
    template: picked.matched ? picked.template || null : null,
    link_lists: {
      ...ll0,
      comment_link_mode: "match_media",
      comment_bundle_mode: "merged",
    },
    used_link_index: null,
    mode: "match_media",
    media_ordinal: extractOrdinalFromName(mediaRef),
    match_reason: url ? "merged_opener" : "merged_missing_link",
    comment_site: url ? extractCommentSite(url) : null,
    site_page_count: null,
  };
}

/**
 * @returns {{ text: string|null, link: string|null, template: string|null, link_lists: object, used_link_index: number|null }}
 */
export function assignCommentForPost(cfg = {}) {
  if (cfg.comment_style === "classic") return assignClassicComment(cfg);
  const ll0 = cfg.link_lists && typeof cfg.link_lists === "object" ? { ...cfg.link_lists } : {};
  const withLinkFlag =
    ll0.comment_with_link === true ||
    ll0.comment_with_link === 1 ||
    ll0.comment_with_link === "1" ||
    String(ll0.comment_with_link || "").toLowerCase() === "on";
  // Chỉ khớp link theo media khi user chọn mode comment = match_media.
  const wantMatch =
    !!cfg.force_comment_match_media ||
    getCommentPickMode(ll0, cfg.comment_pick_mode || "random") === "match_media";
  const mode = wantMatch
    ? "match_media"
    : getCommentPickMode(ll0, cfg.comment_pick_mode || "random");
  if (mode === "match_media" && commentBundleMode(ll0) === "merged") {
    return assignMergedBundleComment(cfg, ll0);
  }
  // Random / lần lượt: luôn gắn link trong kho. «Kèm link» chỉ tắt ở mode khớp số (tab Theo bộ).
  const withLink = mode !== "match_media" || withLinkFlag;
  const postRound = Math.max(0, Number(cfg.post_round || cfg.postRound) || 0);
  const openFolder = String(ll0.comment_open_folder || cfg.comment_open_folder || "").trim();
  const fromFolder = loadNumberedFolderLines(openFolder);
  const templates = fromFolder.length ? fromFolder : normalizeLineList(cfg.comment_templates);
  const pageRowId = Number(cfg.page_row_id) || 0;
  const siteTracker = cfg.comment_site_tracker || null;
  const maxPagesPerSite =
    siteTracker?.maxPagesPerSite ?? getCommentMaxPagesPerSite(ll0, 0);
  const linkSiteOk = (url) => {
    if (!siteTracker || !maxPagesPerSite) return true;
    const site = extractCommentSite(url);
    if (!site) return true;
    return siteTracker.canUse(site, pageRowId);
  };
  /** Link còn trong ngân sách site (fallback khi miss slug / site matched đã đủ). */
  const pickAllowedFallback = (pool, nextIdx, pickMode = "random") => {
    const allowed = (pool || []).filter((u) => linkSiteOk(u));
    if (!allowed.length) {
      return { link: "", linkNext: nextIdx, usedLinkIndex: null, siteSkipReason: "all_sites_at_cap" };
    }
    const start = Math.abs(Number(nextIdx) || 0) % allowed.length;
    const p = pickFromList(allowed, pickMode === "sequential" ? "sequential" : "random", nextIdx);
    return {
      link: p.item,
      linkNext: p.nextIndex,
      usedLinkIndex: pickMode === "sequential" ? start : allowed.indexOf(p.item),
      siteSkipReason: null,
    };
  };
  // Keep raw lines (may include "1. https://...") for ordinal matching
  const rawLinkLines = (() => {
    const ll = ll0;
    const buckets = [ll.comment_links, ll.full_album, ll.see_more];
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
  let tplText = ""; // câu sạch (đã bỏ "9." và URL nếu có trên cùng dòng)
  let tplEmbeddedUrl = "";
  let tplNext = Number(ll0.comment_tpl_next) || 0;
  if (templates.length) {
    // Templates: match_media → khớp số đầu câu kèm với số media (9. Critics… ↔ 9-video.mp4)
    if (mode === "match_media") {
      const mediaRef = cfg.media_path || cfg.media_name || "";
      let pickedTpl = pickCommentTemplateByMediaOrdinal(templates, mediaRef);
      // Không khớp số trên câu → dùng post_round (bộ media chung mọi page)
      if (pickedTpl.template && pickedTpl.matched) {
        tpl = pickedTpl.template;
        tplText = pickedTpl.text || pickedTpl.template;
        tplEmbeddedUrl = pickedTpl.url || "";
        tplNext = tplNext + 1;
      }
    } else {
      const p = pickFromList(templates, mode === "sequential" ? "sequential" : "random", tplNext);
      tpl = p.item;
      const parsed = parseNumberedCommentTemplate(tpl);
      // random/sequential: giữ nguyên câu (kể cả số) trừ khi có URL nhúng
      tplText = parsed.url ? parsed.text : tpl;
      tplEmbeddedUrl = parsed.url || "";
      tplNext = p.nextIndex;
    }
  }

  let link = "";
  let linkNext = Number(ll0.comment_link_next) || 0;
  let usedLinkIndex = null;
  let matchMeta = null;
  let siteSkipReason = null;
  // Không tick «kèm link» → comment chỉ là câu mở đầu (kể cả URL đã viết sẵn trong câu)
  if (!withLink) {
    link = "";
    tplEmbeddedUrl = "";
  }
  // URL nhúng trong câu kèm (cùng dòng) — ưu tiên nếu site còn slot
  if (withLink && tplEmbeddedUrl && linkSiteOk(tplEmbeddedUrl)) {
    link = tplEmbeddedUrl;
    matchMeta = {
      url: link,
      reason: "template_embedded_url",
      ordinal: extractOrdinalFromName(cfg.media_path || cfg.media_name || ""),
    };
  } else if (withLink && (links.length || rawLinkLines.length)) {
    if (mode === "match_media") {
      const mediaRef = cfg.media_path || cfg.media_name || "";
      const picked = pickLinkByMediaOrdinal(
        rawLinkLines.length ? rawLinkLines : links,
        mediaRef,
        { postRound }
      );
      matchMeta = picked;
      if (picked.url && linkSiteOk(picked.url)) {
        link = picked.url;
        usedLinkIndex = picked.used_link_index;
      } else {
        // Không lấy link số khác — bỏ comment lệch số
        const why = picked.url
          ? `site_cap:${extractCommentSite(picked.url)}`
          : `match_miss:${picked.reason || "?"}`;
        link = "";
        usedLinkIndex = null;
        siteSkipReason = why;
        console.warn(
          `[assignCommentForPost] ${why} media=${mediaRef} → không gắn link lệch số`
        );
      }
    } else {
      // random / sequential: chỉ chọn link thuộc site còn slot page
      const fb = pickAllowedFallback(links, linkNext, mode);
      if (!fb.link) {
        link = "";
        usedLinkIndex = null;
        siteSkipReason = fb.siteSkipReason || "all_sites_at_cap";
        console.warn(
          `[assignCommentForPost] mọi site đã đủ ${maxPagesPerSite} page → skip comment (page=${pageRowId})`
        );
      } else {
        link = fb.link;
        linkNext = fb.linkNext;
        usedLinkIndex = fb.usedLinkIndex;
      }
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
  // match_media: dùng câu đã bỏ "9." (+ URL nhúng nếu có) — tplText
  const bodyTpl = (tplText || tpl || "").trim();
  if (bodyTpl) {
    const hasPh =
      /\{see_more\}|\{full_album\}|\{link\}|\{link:[a-zA-Z0-9_]+\}/.test(bodyTpl);
    text = bodyTpl
      .replace(/\{link:([a-zA-Z0-9_]+)\}/g, (_, key) => pickKey(key) || link || "")
      .replace(/\{see_more\}/g, () => pickKey("see_more") || link || "")
      .replace(/\{full_album\}/g, () => pickKey("full_album") || link || "")
      .replace(/\{link\}/g, () => link || pickKey("see_more") || pickKey("full_album") || "");
    // Chỉ ghép link khi đã tick «Comment kèm link»
    if (withLink && link && !text.includes(link)) {
      text = `${text.trim()}\n${link}`.trim();
    } else if (withLink && !link && hasPh) {
      // placeholder rỗng → bỏ dòng trống thừa
      text = text.replace(/\n{2,}/g, "\n").trim();
    }
  } else if (link) {
    text = link;
  }

  // Template kiểu "see more :" mà không có link nào trong kho → null (đừng comment rỗng ý nghĩa)
  text = String(text || "").trim() || null;
  // Chỉ bắt link khi đã tick kèm link
  if (withLink && (mode === "match_media" || siteSkipReason) && !link) {
    text = null;
  }
  if (text && !link && !/https?:\/\//i.test(text)) {
    // Chỉ câu mẫu, không URL — vẫn cho gửi (user có thể chỉ muốn text),
    // nhưng ghi log để debug bulk
    console.warn(
      "[assignCommentForPost] comment không có URL — kho link trống (comment_links / caption_lead_links)"
    );
  }

  const usedSite = link ? extractCommentSite(link) : "";
  if (text && link && siteTracker && usedSite) {
    siteTracker.record(usedSite, pageRowId);
  }

  const link_lists = {
    ...ll0,
    comment_link_mode: mode,
    comment_tpl_next: tplNext,
    comment_link_next: linkNext,
    comment_max_pages_per_site: maxPagesPerSite,
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
    match_reason: matchMeta?.reason || siteSkipReason || null,
    comment_site: usedSite || null,
    site_page_count: usedSite && siteTracker ? siteTracker.count(usedSite) : null,
  };
}
