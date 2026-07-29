/**
 * Facebook Page Stories (official Graph API) + practical "link" strategies.
 *
 * Meta Page Stories API (2024–2026) only publishes photo/video media.
 * There is NO official parameter for Story link stickers.
 *
 * Link modes we implement (honest UX):
 *  - combo   (default): Story media + companion Feed post with the link
 *  - overlay: burn URL bar onto image (Windows GDI) then Story; optional combo feed
 *  - media_only: Story only (no link)
 *  - feed_link: skip Story — only Feed link post (fallback if Story fails)
 *
 * Refs: https://developers.facebook.com/docs/page-stories-api/
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { graphBase } from "../config.js";
import {
  noteGraphResponse,
  isNetworkTransientError,
  estimateTransientWaitMs,
} from "./rateLimit.js";
import {
  appsecretProof,
  isInvalidAppSecretProofError,
  resolveAppSecret,
} from "./facebook.js";
import {
  publishPhoto,
  publishText,
  isImageFile,
  isVideoFile,
} from "./publish.js";

function proofForToken(pageToken, metaAppKey = "") {
  const secret = resolveAppSecret("", metaAppKey);
  return appsecretProof(pageToken, secret);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function wrapFetchError(e, label = "Graph") {
  const causeMsg = e?.cause?.message || e?.cause?.code || "";
  const msg = e?.message || String(e);
  const full = causeMsg && !msg.includes(causeMsg) ? `${msg} (${causeMsg})` : msg;
  const err = new Error(
    /fetch failed/i.test(full)
      ? `fetch failed — không kết nối được Facebook (${label})`
      : full
  );
  err.network = true;
  return err;
}

async function withRetry(fn) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const networkish =
        isNetworkTransientError(e) ||
        (/fetch failed/i.test(String(e?.message || "")) && !e?.fb);
      if (!networkish || attempt >= 2) throw e;
      await sleep(
        estimateTransientWaitMs(e, { attempt, minMs: 1500, maxMs: 12000 })
      );
    }
  }
  throw last;
}

async function graphForm(urlPath, pageToken, fields = {}, fileField = null, metaAppKey = "") {
  return withRetry(async () => {
    const tryOnce = async (withProof) => {
      const url = `${graphBase()}${urlPath}`;
      const form = new FormData();
      form.append("access_token", pageToken);
      if (withProof) {
        const proof = proofForToken(pageToken, metaAppKey);
        if (proof) form.append("appsecret_proof", proof);
      }
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined && v !== null) form.append(k, String(v));
      }
      if (fileField) {
        const buf = fs.readFileSync(fileField.filePath);
        form.append(
          fileField.name,
          new Blob([buf]),
          path.basename(fileField.filePath)
        );
      }
      let res;
      try {
        res = await fetch(url, { method: "POST", body: form });
      } catch (e) {
        throw wrapFetchError(e, "story form");
      }
      noteGraphResponse(res);
      return res.json();
    };
    let data = await tryOnce(true);
    if (data?.error && isInvalidAppSecretProofError(data.error.message)) {
      data = await tryOnce(false);
    }
    if (data.error) {
      const err = new Error(data.error.message || "Story Graph error");
      err.code = data.error.code;
      err.fb = data.error;
      throw err;
    }
    return data;
  });
}

async function graphJson(urlPath, pageToken, body = {}, metaAppKey = "") {
  return withRetry(async () => {
    const tryOnce = async (withProof) => {
      const url = new URL(`${graphBase()}${urlPath}`);
      url.searchParams.set("access_token", pageToken);
      if (withProof) {
        const proof = proofForToken(pageToken, metaAppKey);
        if (proof) url.searchParams.set("appsecret_proof", proof);
      }
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (e) {
        throw wrapFetchError(e, "story json");
      }
      noteGraphResponse(res);
      return res.json();
    };
    let data = await tryOnce(true);
    if (data?.error && isInvalidAppSecretProofError(data.error.message)) {
      data = await tryOnce(false);
    }
    if (data.error) {
      const err = new Error(data.error.message || "Story Graph error");
      err.code = data.error.code;
      err.fb = data.error;
      throw err;
    }
    return data;
  });
}

/**
 * Burn URL bar onto image (Windows System.Drawing). Returns path to temp PNG/JPG.
 * Non-Windows or failure → null (caller falls back to combo).
 */
export function burnLinkOverlayOnImage(filePath, linkUrl, outDir = null) {
  if (!filePath || !fs.existsSync(filePath) || !isImageFile(filePath)) return null;
  if (process.platform !== "win32") return null;
  const link = String(linkUrl || "").trim();
  if (!link) return null;

  const dir = outDir || path.join(path.dirname(filePath), "_story_link");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  const base = path.basename(filePath, path.extname(filePath));
  const outPath = path.join(dir, `${base}_storylink.jpg`);
  const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile(${JSON.stringify(filePath)})
try {
  $w = $src.Width; $h = $src.Height
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'HighQuality'
  $g.DrawImage($src, 0, 0, $w, $h)
  $barH = [Math]::Max(48, [int]($h * 0.10))
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(200, 0, 0, 0))
  $g.FillRectangle($brush, 0, $h - $barH, $w, $barH)
  $fontSize = [Math]::Max(14, [int]($barH * 0.35))
  $font = New-Object System.Drawing.Font 'Segoe UI', $fontSize, ([System.Drawing.FontStyle]::Bold)
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $text = ${JSON.stringify(link.length > 80 ? link.slice(0, 77) + "..." : link)}
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = 'Center'
  $sf.LineAlignment = 'Center'
  $rect = New-Object System.Drawing.RectangleF 8, ($h - $barH), ($w - 16), $barH
  $g.DrawString($text, $font, $white, $rect, $sf)
  $jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, 90L)
  $bmp.Save(${JSON.stringify(outPath)}, $jpegCodec, $ep)
  $g.Dispose(); $bmp.Dispose(); $brush.Dispose(); $white.Dispose(); $font.Dispose()
} finally { $src.Dispose() }
if (-not (Test-Path -LiteralPath ${JSON.stringify(outPath)})) { exit 2 }
`;
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript],
    { windowsHide: true, timeout: 60000, encoding: "utf8" }
  );
  if (r.status !== 0 || !fs.existsSync(outPath)) {
    console.warn("[story-link] overlay failed:", r.stderr || r.stdout || r.status);
    return null;
  }
  return outPath;
}

/** Normalize link mode */
export function normalizeStoryLinkMode(raw) {
  const m = String(raw || "combo").toLowerCase().trim();
  if (["combo", "overlay", "media_only", "feed_link", "overlay_combo"].includes(m)) {
    return m === "overlay" ? "overlay_combo" : m;
  }
  return "combo";
}

/**
 * Official Photo Story: unpublished photo → photo_stories
 * @returns {{ success, post_id, photo_id, post_url, raw }}
 */
export async function publishPhotoStory(pageId, pageToken, filePath, opts = {}) {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  if (!isImageFile(filePath)) throw new Error("Story photo cần file ảnh");

  // 1) Upload unpublished (required by Page Stories API)
  const up = await graphForm(
    `/${pageId}/photos`,
    pageToken,
    {
      published: "false",
      caption: opts.caption || "",
    },
    { name: "source", filePath },
    opts.metaAppKey
  );
  const photoId = up.id;
  if (!photoId) throw new Error("Upload photo unpublished thất bại (thiếu id)");

  // 2) Publish as story — official API only accepts photo_id
  // Experimental: some clients sent link= — Meta rejects / ignores; we do not rely on it.
  const pubBody = { photo_id: photoId };
  const story = await graphJson(
    `/${pageId}/photo_stories`,
    pageToken,
    pubBody,
    opts.metaAppKey
  );
  if (!story.success && !story.post_id) {
    throw new Error("photo_stories không trả success");
  }
  const postId = story.post_id || null;
  return {
    success: true,
    post_id: postId,
    photo_id: photoId,
    post_url: postId ? `https://www.facebook.com/${postId}` : null,
    media_type: "photo",
    raw: { upload: up, story },
  };
}

/**
 * Official Video Story: start session → rupload → finish
 */
export async function publishVideoStory(pageId, pageToken, filePath, opts = {}) {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  if (!isVideoFile(filePath)) throw new Error("Story video cần file video");

  const start = await graphJson(
    `/${pageId}/video_stories`,
    pageToken,
    { upload_phase: "start" },
    opts.metaAppKey
  );
  const videoId = start.video_id;
  const uploadUrl = start.upload_url;
  if (!videoId || !uploadUrl) {
    throw new Error("video_stories start thất bại (thiếu video_id/upload_url)");
  }

  const buf = fs.readFileSync(filePath);
  const fileSize = buf.length;
  // Hosted on Meta rupload — binary body + offset headers
  const upRes = await withRetry(async () => {
    let res;
    try {
      res = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: `OAuth ${pageToken}`,
          offset: "0",
          file_size: String(fileSize),
          "Content-Type": "application/octet-stream",
        },
        body: buf,
      });
    } catch (e) {
      throw wrapFetchError(e, "rupload video story");
    }
    noteGraphResponse(res);
    const data = await res.json().catch(() => ({}));
    if (data.error) {
      const err = new Error(data.error.message || "Video rupload error");
      err.fb = data.error;
      throw err;
    }
    if (data.success === false) {
      throw new Error("Video rupload success=false");
    }
    return data;
  });

  const fin = await graphJson(
    `/${pageId}/video_stories`,
    pageToken,
    { video_id: videoId, upload_phase: "finish" },
    opts.metaAppKey
  );
  if (!fin.success && !fin.post_id) {
    throw new Error("video_stories finish thất bại");
  }
  const postId = fin.post_id || null;
  return {
    success: true,
    post_id: postId,
    video_id: videoId,
    post_url: postId ? `https://www.facebook.com/${postId}` : null,
    media_type: "video",
    raw: { start, upload: upRes, finish: fin },
  };
}

/**
 * Full story publish with link strategy.
 *
 * @param {object} opts
 * @param {string} opts.pageId
 * @param {string} opts.pageToken
 * @param {string} opts.filePath
 * @param {string} [opts.link] - URL to attach (combo/overlay)
 * @param {string} [opts.caption]
 * @param {string} [opts.link_mode] - combo | overlay_combo | media_only | feed_link
 * @param {string} [opts.metaAppKey]
 * @param {string} [opts.story_type] - auto | photo | video
 */
export async function publishPageStoryWithLink(opts = {}) {
  const pageId = String(opts.pageId || "").trim();
  const pageToken = String(opts.pageToken || "").trim();
  let filePath = String(opts.filePath || "").trim();
  const link = String(opts.link || opts.story_link || "").trim();
  const caption = String(opts.caption || "").trim();
  const mode = normalizeStoryLinkMode(opts.link_mode || opts.story_link_mode);
  const metaAppKey = opts.metaAppKey || "app1";

  if (!pageId || !pageToken) throw new Error("Thiếu pageId/pageToken");

  const notes = [];
  notes.push(
    "Meta API Story chỉ nhận ảnh/video — không có sticker link chính thức (2026)."
  );

  // feed_link only
  if (mode === "feed_link") {
    if (!link) throw new Error("feed_link mode cần URL");
    const msg = [caption, link].filter(Boolean).join("\n\n");
    const feed = await publishText(pageId, pageToken, msg);
    return {
      ok: true,
      kind: "feed_link",
      story: null,
      feed,
      link,
      link_mode: mode,
      notes,
      post_id: feed.post_id,
      post_url: feed.post_url,
    };
  }

  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error("Story cần file ảnh/video trong media_folder");
  }

  let usedPath = filePath;
  let overlayPath = null;

  // overlay: burn link on image
  if ((mode === "overlay_combo" || mode === "overlay") && link && isImageFile(filePath)) {
    overlayPath = burnLinkOverlayOnImage(filePath, link);
    if (overlayPath) {
      usedPath = overlayPath;
      notes.push("Đã in URL lên ảnh Story (overlay Windows).");
    } else {
      notes.push("Overlay ảnh thất bại → đăng Story media gốc + feed link.");
    }
  } else if ((mode === "overlay_combo" || mode === "overlay") && link && isVideoFile(filePath)) {
    notes.push("Overlay URL trên video chưa hỗ trợ → Story video + feed link.");
  }

  let story = null;
  const forceType = String(opts.story_type || "auto").toLowerCase();
  const asPhoto =
    forceType === "photo" ||
    (forceType === "auto" && isImageFile(usedPath));
  const asVideo =
    forceType === "video" ||
    (forceType === "auto" && isVideoFile(usedPath));

  if (!asPhoto && !asVideo) {
    throw new Error("File không phải ảnh/video hỗ trợ Story");
  }

  if (mode !== "feed_link") {
    if (asPhoto) {
      story = await publishPhotoStory(pageId, pageToken, usedPath, {
        caption,
        metaAppKey,
      });
      notes.push("Đã publish Photo Story (photo_stories).");
    } else {
      story = await publishVideoStory(pageId, pageToken, usedPath, {
        metaAppKey,
      });
      notes.push("Đã publish Video Story (video_stories).");
    }
  }

  let feed = null;
  const wantCompanion =
    mode === "combo" ||
    mode === "overlay_combo" ||
    (mode === "overlay" && link);

  if (wantCompanion && link) {
    const feedMsg = [
      caption || "🔗 Link",
      link,
      story?.post_url ? `Story: ${story.post_url}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    try {
      // Prefer feed with link param for OG preview
      feed = await publishFeedWithLink(pageId, pageToken, {
        message: feedMsg,
        link,
        metaAppKey,
      });
      notes.push("Đã đăng Feed kèm link (OG preview) — bù sticker link Story.");
    } catch (e) {
      // fallback text-only
      feed = await publishText(pageId, pageToken, feedMsg);
      notes.push(`Feed link param lỗi (${e.message}) → text feed có URL.`);
    }
  } else if (wantCompanion && !link) {
    notes.push("Không có URL → chỉ Story media (media_only).");
  }

  return {
    ok: true,
    kind: "story_with_link_strategy",
    link_mode: mode,
    link: link || null,
    story,
    feed,
    overlay_path: overlayPath,
    media_path_used: usedPath,
    notes,
    post_id: story?.post_id || feed?.post_id || null,
    post_url: story?.post_url || feed?.post_url || null,
    meta_limitation:
      "Official API cannot attach clickable link stickers on Page Stories.",
  };
}

/** Feed post with link (Open Graph card) */
export async function publishFeedWithLink(pageId, pageToken, opts = {}) {
  const link = String(opts.link || "").trim();
  if (!link) throw new Error("Thiếu link");
  const message = String(opts.message || "").trim();
  // Graph: POST /page-id/feed with link + message
  const data = await graphJson(
    `/${pageId}/feed`,
    pageToken,
    {
      message: message || link,
      link,
      ...(opts.picture ? { picture: opts.picture } : {}),
    },
    opts.metaAppKey
  );
  const postId = data.id || null;
  return {
    post_id: postId,
    post_url: postId ? `https://www.facebook.com/${postId}` : null,
    raw: data,
  };
}
