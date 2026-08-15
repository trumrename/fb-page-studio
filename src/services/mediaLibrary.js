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
  const modeRaw = String(
    ll0.caption_lead_mode || ll0.comment_link_mode || "random"
  )
    .trim()
    .toLowerCase();
  const mode =
    modeRaw === "sequential" || modeRaw === "sequence" || modeRaw === "theo_bai"
      ? "sequential"
      : "random";

  if (!templates.length && !links.length) {
    return { text: body, lead: null, link: null, link_lists: ll0 };
  }

  let tplNext = Number(ll0.caption_lead_tpl_next) || 0;
  let linkNext = Number(ll0.caption_lead_link_next) || 0;
  let tpl = "";
  let link = "";

  if (templates.length) {
    if (mode === "sequential") {
      const i = Math.abs(tplNext) % templates.length;
      tpl = templates[i];
      tplNext = i + 1;
    } else {
      tpl = templates[Math.floor(Math.random() * templates.length)];
      tplNext += 1;
    }
  }
  if (links.length) {
    if (mode === "sequential") {
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
    for (const u of arr) {
      const k = String(u || "").trim().toLowerCase();
      if (!k || seen.has(k)) continue;
      // chỉ nhận URL-ish
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
 * random | sequential (theo từng bài của page — xoay vòng list)
 */
export function getCommentPickMode(linkLists = {}, fallback = "random") {
  const m = String(linkLists?.comment_link_mode || linkLists?.comment_pick_mode || fallback)
    .trim()
    .toLowerCase();
  return m === "sequential" || m === "sequence" || m === "theo_bai" ? "sequential" : "random";
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
 * - Câu kèm trống + có link → comment = chỉ URL.
 * - Template có {link}/{see_more}/{full_album} → thay (legacy).
 * - Template không placeholder (vd "see more :") + có link → "câu\nlink".
 *
 * @returns {{ text: string|null, link: string|null, template: string|null, link_lists: object, used_link_index: number|null }}
 */
export function assignCommentForPost(cfg = {}) {
  const ll0 = cfg.link_lists && typeof cfg.link_lists === "object" ? { ...cfg.link_lists } : {};
  const mode = getCommentPickMode(ll0, cfg.comment_pick_mode || "random");
  const templates = normalizeLineList(cfg.comment_templates);
  const links = getCommentLinkPool(ll0);

  if (!templates.length && !links.length) {
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
    const p = pickFromList(templates, mode, tplNext);
    tpl = p.item;
    tplNext = p.nextIndex;
  }

  let link = "";
  let linkNext = Number(ll0.comment_link_next) || 0;
  let usedLinkIndex = null;
  if (links.length) {
    const start = Math.abs(Number(ll0.comment_link_next) || 0) % links.length;
    const p = pickFromList(links, mode, linkNext);
    link = p.item;
    linkNext = p.nextIndex;
    usedLinkIndex = mode === "sequential" ? start : links.indexOf(link);
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
  };
}
