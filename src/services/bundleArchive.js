/**
 * Theo bộ: sau khi Facebook nhận bài, chuyển dòng caption / comment / link
 * cùng số sang thư mục «đã đăng» trong từng kho. Không đụng hẹn giờ / đăng trực tiếp.
 * Ghi bản đã đăng trước, rồi mới xóa dòng khỏi file đang dùng.
 */
import fs from "fs";
import path from "path";
import {
  extractLeadingNumber,
  extractOrdinalFromName,
  moveToPosted,
  parseLinkEntry,
} from "./mediaLibrary.js";

const POSTED_NAME = "đã đăng";
const TEXT_EXT = /\.(txt|csv)$/i;

/** Số đầu dòng. Số trong URL không tính — «1. https://…/1100» là bộ 1. */
export function linkLineOrdinal(line) {
  const raw = String(line || "").trim();
  if (!raw) return null;
  const parsed = parseLinkEntry(raw);
  if (parsed) return parsed.lineOrdinal != null ? parsed.lineOrdinal : null;
  return extractLeadingNumber(raw);
}

export function bundleLinkFolder(mediaFolder) {
  const media = String(mediaFolder || "").trim();
  if (!media) return "";
  let dir = "";
  try {
    dir = path.join(path.dirname(path.resolve(media)), "link");
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
  } catch {
    return "";
  }
  return "";
}

/** Có chuyển bộ ngay lần đăng này không. all_pages đợi flush cuối job. */
export function shouldArchiveBundleNow({ matchBundle, keepInInbox, postId } = {}) {
  return !!matchBundle && !keepInInbox && !!postId;
}

export function noteSharedBundleOrdinal(bag, ordinal) {
  const n = Number(ordinal);
  if (!bag || typeof bag !== "object" || !Number.isFinite(n) || n <= 0) return;
  const cur = Array.isArray(bag.__bundleOrdinals) ? bag.__bundleOrdinals : [];
  if (!cur.includes(n)) cur.push(n);
  bag.__bundleOrdinals = cur;
}

function folderKey(folder) {
  const raw = String(folder || "").trim();
  if (!raw) return "";
  try {
    return path.resolve(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

function listTextFiles(folder) {
  const raw = String(folder || "").trim();
  if (!raw || !fs.existsSync(raw)) return [];
  const st = fs.statSync(raw);
  if (st.isFile()) return TEXT_EXT.test(raw) ? [path.resolve(raw)] : [];
  const out = [];
  for (const name of fs.readdirSync(raw)) {
    if (name === POSTED_NAME || !TEXT_EXT.test(name)) continue;
    const full = path.join(raw, name);
    try {
      if (fs.statSync(full).isFile()) out.push(full);
    } catch {
      /* bỏ file khóa */
    }
  }
  out.sort();
  return out;
}

function readBundleFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const text = buf.slice(hasBom ? 3 : 0).toString("utf8");
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const ends = text.endsWith("\n");
  const lines = text.length ? text.split(/\r?\n/) : [];
  if (ends && lines.length && lines[lines.length - 1] === "") lines.pop();
  return { bom: hasBom ? "\uFEFF" : "", nl, ends, lines };
}

function writeBundleFile(filePath, file) {
  const body = file.lines.join(file.nl) + (file.ends && file.lines.length ? file.nl : "");
  fs.writeFileSync(filePath, file.bom + body, "utf8");
}

function contentLines(filePath) {
  try {
    return readBundleFile(filePath).lines;
  } catch {
    return [];
  }
}

function archivedLineSet(postedDir) {
  const seen = new Set();
  if (!postedDir || !fs.existsSync(postedDir)) return seen;
  for (const file of listTextFiles(postedDir)) {
    for (const line of contentLines(file)) {
      const t = String(line || "").trim();
      if (t) seen.add(t);
    }
  }
  return seen;
}

function appendLinesFirst(postedDir, fileName, source, removed) {
  fs.mkdirSync(postedDir, { recursive: true });
  const destPath = path.join(postedDir, fileName);
  const seen = archivedLineSet(postedDir);
  const adding = [];
  for (const line of removed) {
    const t = String(line || "").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    adding.push(line);
  }
  if (!adding.length) return;
  const dest = fs.existsSync(destPath)
    ? readBundleFile(destPath)
    : { bom: source.bom, nl: source.nl, ends: true, lines: [] };
  dest.lines.push(...adding);
  dest.ends = true;
  writeBundleFile(destPath, dest);
}

function fileIsWholeOrdinal(filePath, lines, ordinal) {
  if (extractOrdinalFromName(filePath) !== ordinal) return false;
  for (const line of lines) {
    const n = linkLineOrdinal(line);
    if (n != null && n !== ordinal) return false;
  }
  return true;
}

function archiveOneFolder(folder, ordinal, kind) {
  const part = { lines: 0, movedFiles: 0, removedLines: [] };
  const root = String(folder || "").trim();
  if (!root || !fs.existsSync(root)) return part;
  const postedDir = path.join(fs.statSync(root).isDirectory() ? path.resolve(root) : path.dirname(path.resolve(root)), POSTED_NAME);
  for (const file of listTextFiles(root)) {
    const source = readBundleFile(file);
    if (fileIsWholeOrdinal(file, source.lines, ordinal)) {
      const payload = source.lines.filter((line) => String(line || "").trim());
      moveToPosted(file, postedDir);
      part.movedFiles += 1;
      part.lines += Math.max(1, payload.length);
      if (kind === "link") part.removedLines.push(...payload);
      continue;
    }
    const removed = [];
    const kept = [];
    for (const line of source.lines) {
      if (linkLineOrdinal(line) === ordinal) removed.push(line);
      else kept.push(line);
    }
    if (!removed.length) continue;
    appendLinesFirst(postedDir, path.basename(file), source, removed);
    if (kept.some((line) => String(line || "").trim())) {
      writeBundleFile(file, { ...source, lines: kept });
    } else {
      fs.unlinkSync(file);
    }
    part.lines += removed.length;
    if (kind === "link") part.removedLines.push(...removed);
  }
  return part;
}

export function archiveBundleInbox({ ordinal, captionsFolder, commentFolder, linkFolder } = {}) {
  const n = Number(ordinal);
  const report = {
    ordinal: Number.isFinite(n) ? n : null,
    captionLines: 0,
    commentLines: 0,
    linkLines: 0,
    movedFiles: 0,
    removedLinkLines: [],
  };
  if (!Number.isFinite(n) || n <= 0) return report;
  const seen = new Set();
  const jobs = [
    ["caption", captionsFolder],
    ["comment", commentFolder],
    ["link", linkFolder],
  ];
  for (const [kind, folder] of jobs) {
    const key = folderKey(folder);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    try {
      const part = archiveOneFolder(folder, n, kind);
      if (kind === "caption") report.captionLines += part.lines;
      else if (kind === "comment") report.commentLines += part.lines;
      else report.linkLines += part.lines;
      report.movedFiles += part.movedFiles;
      if (kind === "link") report.removedLinkLines.push(...part.removedLines);
    } catch (e) {
      console.warn(`[bundle-archive] ${kind} số ${n}: ${e.message || e}`);
    }
  }
  return report;
}

/** Số đã nằm trong link/đã đăng và không còn trong file link đang dùng. */
export function archivedLinkOrdinals(linkFolder) {
  const posted = new Set();
  const root = String(linkFolder || "").trim();
  if (!root || !fs.existsSync(root)) return posted;
  const postedDir = path.join(path.resolve(root), POSTED_NAME);
  const live = new Set();
  for (const file of listTextFiles(root)) {
    for (const line of contentLines(file)) {
      const n = linkLineOrdinal(line);
      if (n != null) live.add(n);
    }
  }
  if (fs.existsSync(postedDir)) {
    for (const file of listTextFiles(postedDir)) {
      for (const line of contentLines(file)) {
        const n = linkLineOrdinal(line);
        if (n != null) posted.add(n);
      }
    }
  }
  for (const n of live) posted.delete(n);
  return posted;
}

/** Dòng link chỉ có trong DB, không có trong file. Ghi dấu vào link/đã đăng. */
export function rememberArchivedLinkLines(linkFolder, lines) {
  const root = String(linkFolder || "").trim();
  const incoming = Array.isArray(lines) ? lines : [];
  if (!root || !incoming.length || !fs.existsSync(root)) return 0;
  const postedDir = path.join(path.resolve(root), POSTED_NAME);
  const seen = archivedLineSet(postedDir);
  const adding = [];
  for (const line of incoming) {
    const t = String(line || "").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    adding.push(t);
  }
  if (!adding.length) return 0;
  fs.mkdirSync(postedDir, { recursive: true });
  const destPath = path.join(postedDir, "LINKS_DA_DANG.txt");
  const dest = fs.existsSync(destPath)
    ? readBundleFile(destPath)
    : { bom: "", nl: "\n", ends: true, lines: [] };
  dest.lines.push(...adding);
  dest.ends = true;
  writeBundleFile(destPath, dest);
  return adding.length;
}
