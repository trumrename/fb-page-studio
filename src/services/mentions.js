/**
 * Gắn thẻ (mention) Page / User theo Graph API: @[ID]
 *
 * Giới hạn Meta (quan trọng):
 * - Mention Page khác trong bài Page: cần feature Page Mentioning (App Review) để live.
 * - Mention người (PSID) trong comment: thường chỉ khi người đó đã tương tác bài/Page.
 * - Không thể tag tùy ý mọi user cá nhân như trên UI Facebook thủ công.
 *
 * Cú pháp hỗ trợ trong caption/comment:
 * - @[123456789]          — Graph native (giữ nguyên)
 * - {tag} / {mention}     — thay bằng toàn bộ ID đã cấu hình
 * - {tag:1} / {mention:2} — mention thứ N (1-based)
 *
 * Nếu bật mention mà chữ không có placeholder → chèn đầu chuỗi (prefix).
 */

/** Chuẩn hóa 1 ID → digits only (bỏ @[ ], URL, chữ). */
export function normalizeMentionId(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  // @[123] or @123
  const bracket = s.match(/^@?\[(\d{5,})\]$/);
  if (bracket) return bracket[1];
  const at = s.match(/^@(\d{5,})$/);
  if (at) return at[1];
  // facebook.com/.../profile.php?id=123 or /pages/.../123
  const fromUrl = s.match(/[?&]id=(\d{5,})/i) || s.match(/facebook\.com\/(?:pages\/[^/]+\/)?(\d{5,})/i);
  if (fromUrl) return fromUrl[1];
  // "Name | 123" or "123 | Name" or plain digits
  const pipe = s.split("|").map((x) => x.trim());
  for (const part of pipe) {
    if (/^\d{5,}$/.test(part)) return part;
  }
  if (/^\d{5,}$/.test(s)) return s;
  const digits = s.match(/\d{5,}/);
  return digits ? digits[0] : "";
}

/** Graph message fragment */
export function formatMention(id) {
  const n = normalizeMentionId(id);
  return n ? `@[${n}]` : "";
}

/**
 * Parse kho ID (textarea / mảng).
 * Mỗi dòng: ID | nhãn tùy chọn
 * @returns {{ id: string, label: string, token: string }[]}
 */
export function parseMentionList(raw) {
  const lines = Array.isArray(raw)
    ? raw.map((s) => String(s || "").trim()).filter(Boolean)
    : String(raw || "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const id = normalizeMentionId(line);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    let label = "";
    if (line.includes("|")) {
      const parts = line.split("|").map((p) => p.trim());
      label = parts.find((p) => p && !/^\d{5,}$/.test(p) && !/^@?\[\d+\]$/.test(p)) || "";
    }
    out.push({ id, label, token: formatMention(id) });
  }
  return out;
}

export function getMentionsFromConfig(cfg = {}) {
  const ll = cfg.link_lists && typeof cfg.link_lists === "object" ? cfg.link_lists : {};
  const raw =
    cfg.mention_ids ??
    ll.mention_ids ??
    ll.tag_ids ??
    cfg.tag_ids ??
    "";
  return parseMentionList(raw);
}

export function mentionsEnabled(cfg = {}, where = "caption") {
  const ll = cfg.link_lists && typeof cfg.link_lists === "object" ? cfg.link_lists : {};
  const on =
    cfg.mention_enabled ??
    ll.mention_enabled ??
    ll.tag_enabled;
  if (on === false || on === 0 || on === "0" || on === "off") return false;
  // Nếu có list ID thì coi như bật (trừ khi explicit off)
  const list = getMentionsFromConfig(cfg);
  if (!list.length) return false;
  if (on === true || on === 1 || on === "1" || on === "on") {
    /* explicit on */
  } else if (on == null || on === "") {
    // có list = bật
  } else {
    return false;
  }
  const target = String(
    cfg.mention_target ?? ll.mention_target ?? "both"
  ).toLowerCase();
  if (target === "both" || target === "all") return true;
  if (where === "caption") return target === "caption" || target === "post";
  if (where === "comment") return target === "comment";
  return true;
}

/**
 * Áp mention vào text.
 * @param {string} text
 * @param {object} cfg page post config
 * @param {"caption"|"comment"} where
 * @param {{ position?: "prefix"|"suffix"|"placeholder_only" }} opts
 */
export function applyMentionsToText(text, cfg = {}, where = "caption", opts = {}) {
  const body = text == null ? "" : String(text);
  if (!mentionsEnabled(cfg, where)) {
    // Vẫn mở rộng {tag} rỗng / giữ @[id] đã viết tay
    return expandPlaceholders(body, []);
  }
  const mentions = getMentionsFromConfig(cfg);
  const allTokens = mentions.map((m) => m.token).filter(Boolean);
  let out = expandPlaceholders(body, mentions);

  const hasPh =
    /\{tag(?::\d+)?\}/i.test(body) ||
    /\{mention(?::\d+)?\}/i.test(body) ||
    /\{tags\}/i.test(body);
  const alreadyHas = allTokens.some((t) => out.includes(t));
  const position = String(
    opts.position ||
      cfg.mention_position ||
      cfg.link_lists?.mention_position ||
      "prefix"
  ).toLowerCase();

  if (!hasPh && !alreadyHas && allTokens.length) {
    const block = allTokens.join(" ");
    if (position === "suffix" || position === "end") {
      out = `${out.trim()}${out.trim() ? "\n" : ""}${block}`.trim();
    } else if (position === "placeholder_only" || position === "none") {
      /* không tự chèn */
    } else {
      // prefix (mặc định theo user)
      out = `${block}${out.trim() ? ` ${out.trim()}` : ""}`.trim();
    }
  }
  return out;
}

function expandPlaceholders(text, mentions) {
  let s = String(text || "");
  const all = mentions.map((m) => m.token).filter(Boolean).join(" ");
  s = s.replace(/\{tags\}/gi, () => all);
  s = s.replace(/\{tag\}/gi, () => all);
  s = s.replace(/\{mention\}/gi, () => all);
  s = s.replace(/\{tag:(\d+)\}/gi, (_, n) => {
    const i = Math.max(1, Number(n) || 1) - 1;
    return mentions[i]?.token || "";
  });
  s = s.replace(/\{mention:(\d+)\}/gi, (_, n) => {
    const i = Math.max(1, Number(n) || 1) - 1;
    return mentions[i]?.token || "";
  });
  // Chuẩn hóa @123 → @[123] (Graph hay cần ngoặc)
  s = s.replace(/(^|[\s\n])@(\d{5,})(?!\])/g, (_, pre, id) => `${pre}@[${id}]`);
  return s;
}
