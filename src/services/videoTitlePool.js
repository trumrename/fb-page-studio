/**
 * Video title pool (optional Meta `title` field — short).
 * Caption bài (description) stays full elsewhere.
 *
 * Mode when enabled:
 *  1) Walk titles in current order start → end
 *  2) When exhausted: shuffle random → walk start → end again
 *
 * State is shared by titles file path (multi-page same kho = xoay chung).
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { config } from "../config.js";
import { loadCaptionsFromDisk } from "./mediaLibrary.js";

const STATE_FILE = () =>
  path.join(
    config.dataDir || path.dirname(config.databasePath),
    "video_title_pool_state.json"
  );

/** Default built-in pack next to app data / project captions */
export function defaultVideoTitlesPath() {
  const candidates = [
    path.join(config.dataDir || "", "media", "captions", "video-titles-300.txt"),
    path.join(
      path.dirname(config.databasePath || process.cwd()),
      "media",
      "captions",
      "video-titles-300.txt"
    ),
    path.resolve(process.cwd(), "data", "media", "captions", "video-titles-300.txt"),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return candidates[0] || path.resolve("data/media/captions/video-titles-300.txt");
}

export function isVideoTitleEnabled(ll = {}) {
  const raw = ll?.video_title_enabled;
  return (
    raw === true ||
    raw === 1 ||
    raw === "1" ||
    String(raw || "").toLowerCase() === "on" ||
    String(raw || "").toLowerCase() === "true" ||
    String(raw || "").toLowerCase() === "yes"
  );
}

export function resolveVideoTitlesPath(ll = {}) {
  const p = String(ll?.video_titles_path || "").trim();
  return p || defaultVideoTitlesPath();
}

/**
 * Load titles from a .txt/.csv file or a folder of them.
 * Reuses caption file parsers (one line / first column = one title).
 */
/** Meta title: UTF-8 ≤255 bytes; chỉ dòng đầu; max ~120 ký tự cho an toàn */
function clampTitleLine(raw) {
  let s = String(raw ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!s) return "";
  s = (s.split("\n").map((l) => l.trim()).find(Boolean) || s)
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(s);
  if (chars.length > 120) s = chars.slice(0, 120).join("");
  let out = "";
  for (const ch of Array.from(s)) {
    const next = out + ch;
    if (Buffer.byteLength(next, "utf8") > 255) break;
    out = next;
  }
  return out;
}

export function loadVideoTitles(titlesPath) {
  const p = String(titlesPath || "").trim();
  if (!p) return [];
  try {
    const list = loadCaptionsFromDisk(p);
    // Bỏ dòng quá dài kiểu caption full (user lỡ trỏ kho caption) — title phải ngắn
    return list
      .map((t) => clampTitleLine(t))
      .filter((t) => t && Buffer.byteLength(t, "utf8") <= 255);
  } catch (e) {
    console.warn("[videoTitlePool] load:", e.message);
    return [];
  }
}

function fingerprint(titles) {
  return crypto
    .createHash("sha1")
    .update(titles.join("\n"))
    .digest("hex")
    .slice(0, 16);
}

function shuffleIndices(n) {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function loadState() {
  try {
    const f = STATE_FILE();
    if (fs.existsSync(f)) {
      return JSON.parse(fs.readFileSync(f, "utf8")) || {};
    }
  } catch (e) {
    console.warn("[videoTitlePool] state load:", e.message);
  }
  return {};
}

function saveState(all) {
  try {
    const f = STATE_FILE();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(all, null, 2), "utf8");
  } catch (e) {
    console.warn("[videoTitlePool] state save:", e.message);
  }
}

function poolKey(titlesPath) {
  return path.resolve(String(titlesPath || "")).toLowerCase();
}

/**
 * @param {{ link_lists?: object }} cfg
 * @returns {{ title: string|null, enabled: boolean, path: string, remaining: number, total: number, warning?: string }}
 */
export function pickNextVideoTitle(cfg = {}) {
  const ll = cfg.link_lists && typeof cfg.link_lists === "object" ? cfg.link_lists : {};
  const enabled = isVideoTitleEnabled(ll);
  const titlesPath = resolveVideoTitlesPath(ll);

  if (!enabled) {
    return {
      title: null,
      enabled: false,
      path: titlesPath,
      remaining: 0,
      total: 0,
    };
  }

  const titles = loadVideoTitles(titlesPath);
  if (!titles.length) {
    return {
      title: null,
      enabled: true,
      path: titlesPath,
      remaining: 0,
      total: 0,
      warning: `Kho title video trống hoặc không đọc được: ${titlesPath}`,
    };
  }

  const key = poolKey(titlesPath);
  const fp = fingerprint(titles);
  const all = loadState();
  let st = all[key] || null;

  // New file / changed content / bad state → sequential order first pass
  const needReset =
    !st ||
    st.fingerprint !== fp ||
    !Array.isArray(st.order) ||
    st.order.length !== titles.length;

  if (needReset) {
    st = {
      fingerprint: fp,
      // First cycle: natural file order 0..n-1
      order: Array.from({ length: titles.length }, (_, i) => i),
      cursor: 0,
      cycle: 0,
    };
  }

  // Exhausted → reshuffle random, start over
  if (st.cursor >= st.order.length) {
    st.order = shuffleIndices(titles.length);
    st.cursor = 0;
    st.cycle = (Number(st.cycle) || 0) + 1;
    st.fingerprint = fp;
  }

  const idx = st.order[st.cursor];
  const title = titles[idx] || null;
  st.cursor += 1;
  all[key] = st;
  saveState(all);

  return {
    title,
    enabled: true,
    path: titlesPath,
    remaining: Math.max(0, st.order.length - st.cursor),
    total: titles.length,
    cycle: st.cycle,
    index_in_cycle: st.cursor, // after advance = position used
  };
}

/** Stats for UI without advancing cursor */
export function videoTitlePoolStats(cfg = {}) {
  const ll = cfg.link_lists && typeof cfg.link_lists === "object" ? cfg.link_lists : {};
  const enabled = isVideoTitleEnabled(ll);
  const titlesPath = resolveVideoTitlesPath(ll);
  const titles = loadVideoTitles(titlesPath);
  const key = poolKey(titlesPath);
  const all = loadState();
  const st = all[key];
  const fp = fingerprint(titles);
  let remaining = titles.length;
  let cycle = 0;
  if (st && st.fingerprint === fp && Array.isArray(st.order)) {
    remaining = Math.max(0, st.order.length - (Number(st.cursor) || 0));
    cycle = Number(st.cycle) || 0;
  }
  return {
    enabled,
    path: titlesPath,
    total: titles.length,
    remaining,
    cycle,
    exists: !!titlesPath && fs.existsSync(titlesPath),
  };
}
