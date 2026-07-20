/**
 * Web / central-server media & caption upload into data/media/*
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { config } from "../config.js";

const PHOTO_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"]);
const CAPTION_EXT = new Set([".txt", ".csv"]);

export function mediaRoot() {
  return path.join(config.dataDir, "media");
}

export function inboxDir() {
  return path.join(mediaRoot(), "inbox");
}

export function postedDir() {
  return path.join(mediaRoot(), "posted");
}

export function captionsDir() {
  return path.join(mediaRoot(), "captions");
}

export function ensureMediaDirs() {
  for (const d of [inboxDir(), postedDir(), captionsDir()]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function safeBaseName(name) {
  const base = path.basename(String(name || "file")).replace(/[^\w.\- ()\u00C0-\u024F]+/g, "_");
  return base.slice(0, 120) || "file";
}

export function classifyUpload(filename) {
  const ext = path.extname(filename || "").toLowerCase();
  if (PHOTO_EXT.has(ext)) return "photo";
  if (VIDEO_EXT.has(ext)) return "video";
  if (CAPTION_EXT.has(ext)) return "caption";
  return "other";
}

/**
 * Save one uploaded file (multer-style: { originalname, buffer|path }).
 * target: inbox | captions | auto
 */
export function saveUploadedFile(file, { target = "auto" } = {}) {
  ensureMediaDirs();
  if (!file) throw new Error("Không có file");
  const original = safeBaseName(file.originalname || file.name || "upload.bin");
  const kind = classifyUpload(original);
  let folder = inboxDir();
  let role = "media";
  if (target === "captions" || (target === "auto" && kind === "caption")) {
    folder = captionsDir();
    role = "caption";
  } else if (kind === "other" && target === "auto") {
    throw new Error(
      `Định dạng không hỗ trợ: ${path.extname(original) || "(không đuôi)"}. Ảnh/video → inbox, .txt/.csv → captions.`
    );
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(3).toString("hex");
  const destName = `${stamp}_${rand}_${original}`;
  const dest = path.join(folder, destName);

  if (file.buffer) {
    fs.writeFileSync(dest, file.buffer);
  } else if (file.path && fs.existsSync(file.path)) {
    fs.copyFileSync(file.path, dest);
    try {
      fs.unlinkSync(file.path);
    } catch {
      /* ignore */
    }
  } else {
    throw new Error("File upload trống");
  }

  const stat = fs.statSync(dest);
  return {
    ok: true,
    role,
    kind: kind === "caption" ? "caption" : kind,
    name: destName,
    path: dest,
    size: stat.size,
    folder,
  };
}

export function listInbox(limit = 100) {
  ensureMediaDirs();
  const dir = inboxDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => !f.startsWith("."))
    .map((name) => {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      return {
        name,
        path: full,
        size: st.size,
        kind: classifyUpload(name),
        mtime: st.mtime.toISOString(),
      };
    })
    .filter((f) => f.kind === "photo" || f.kind === "video")
    .sort((a, b) => b.mtime.localeCompare(a.mtime))
    .slice(0, limit);
  return {
    folder: dir,
    posted_folder: postedDir(),
    captions_folder: captionsDir(),
    count: files.length,
    files,
  };
}
