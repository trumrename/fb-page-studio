/**
 * Official Graph API publish to Facebook Pages (feed only).
 * Story: not implemented here — config flag only.
 * Never invent success — always return Graph error text on failure.
 */
import fs from "fs";
import path from "path";
import { Blob } from "buffer";
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
  err.code = e?.code || e?.cause?.code || "FETCH_FAILED";
  err.cause = e;
  err.network = true;
  return err;
}

/** Low-level: short auto-retry for network/fetch only. */
async function withPublishRetry(fn) {
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const networkish =
        isNetworkTransientError(e) ||
        (/fetch failed/i.test(String(e?.message || "")) && !e?.fb);
      if (!networkish || attempt >= maxAttempts - 1) throw e;
      const waitMs = estimateTransientWaitMs(e, {
        attempt,
        minMs: 2_000,
        maxMs: 20_000,
      });
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

async function graphPostForm(urlPath, pageToken, fields = {}, fileField = null, metaAppKey = "") {
  return withPublishRetry(async () => {
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
        const { name, filePath } = fileField;
        const buf = fs.readFileSync(filePath);
        form.append(name, new Blob([buf]), path.basename(filePath));
      }
      let res;
      try {
        res = await fetch(url, { method: "POST", body: form });
      } catch (e) {
        throw wrapFetchError(e, "POST form");
      }
      noteGraphResponse(res);
      return res.json();
    };
    let data = await tryOnce(true);
    if (data?.error && isInvalidAppSecretProofError(data.error.message)) {
      data = await tryOnce(false);
    }
    if (data.error) {
      const err = new Error(data.error.message || "Graph publish error");
      err.code = data.error.code;
      err.fb = data.error;
      throw err;
    }
    return data;
  });
}

async function graphPostJson(urlPath, pageToken, body = {}, metaAppKey = "") {
  return withPublishRetry(async () => {
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
        throw wrapFetchError(e, "POST json");
      }
      noteGraphResponse(res);
      return res.json();
    };
    let data = await tryOnce(true);
    if (data?.error && isInvalidAppSecretProofError(data.error.message)) {
      data = await tryOnce(false);
    }
    if (data.error) {
      const err = new Error(data.error.message || "Graph publish error");
      err.code = data.error.code;
      err.fb = data.error;
      throw err;
    }
    return data;
  });
}

async function graphGetJson(urlPath, pageToken, fields, metaAppKey = "") {
  return withPublishRetry(async () => {
    const tryOnce = async (withProof) => {
      const url = new URL(`${graphBase()}${urlPath}`);
      url.searchParams.set("access_token", pageToken);
      if (withProof) {
        const proof = proofForToken(pageToken, metaAppKey);
        if (proof) url.searchParams.set("appsecret_proof", proof);
      }
      if (fields) url.searchParams.set("fields", fields);
      let res;
      try {
        res = await fetch(url);
      } catch (e) {
        throw wrapFetchError(e, "GET");
      }
      noteGraphResponse(res);
      return res.json();
    };
    let data = await tryOnce(true);
    if (data?.error && isInvalidAppSecretProofError(data.error.message)) {
      data = await tryOnce(false);
    }
    if (data.error) {
      const err = new Error(data.error.message || "Graph read error");
      err.code = data.error.code;
      err.fb = data.error;
      throw err;
    }
    return data;
  });
}

export function validateScheduleUnix(unixSec) {
  const n = Number(unixSec);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("scheduled_publish_time không hợp lệ (cần UNIX seconds)");
  }
  const now = Math.floor(Date.now() / 1000);
  const min = now + 10 * 60;
  const max = now + 30 * 24 * 60 * 60;
  if (n < min) {
    throw new Error(
      "Hẹn giờ phải cách hiện tại ≥ 10 phút (quy tắc Graph API)"
    );
  }
  if (n > max) {
    throw new Error(
      "Hẹn giờ tối đa 30 ngày kể từ bây giờ (quy tắc Graph API)"
    );
  }
  return Math.floor(n);
}

/**
 * @param {object} [schedule] { scheduled_publish_time: unixSec }
 * @param {{ kind?: 'photo'|'video'|'text' }} [opts]
 *   photo/text: Meta yêu cầu unpublished_content_type=SCHEDULED khi hẹn.
 *   video: chỉ published=false + scheduled_publish_time (+ secret/no_story explicit).
 *   (Gắn SCHEDULED lên /videos đôi khi tạo object kiểu “unpublished” khó public.)
 */
function scheduleFields(schedule, opts = {}) {
  if (!schedule?.scheduled_publish_time) {
    return { published: "true" };
  }
  const t = validateScheduleUnix(schedule.scheduled_publish_time);
  const kind = String(opts.kind || "text").toLowerCase();
  const base = {
    published: "false",
    scheduled_publish_time: String(t),
  };
  // Photo + feed: Meta docs require unpublished_content_type for scheduled
  if (kind !== "video") {
    base.unpublished_content_type = "SCHEDULED";
  }
  return base;
}

/**
 * Ép bài hẹn (đã qua giờ) lên timeline public.
 * Workaround glitch Graph: is_published=false / is_hidden=true dù scheduled_publish_time đã qua.
 * @see Medium/FB eng notes — POST is_published + timeline_visibility + backdated_time
 */
export async function forcePublishScheduledObject(
  objectId,
  pageToken,
  scheduledUnixSec = null,
  metaAppKey = ""
) {
  if (!objectId) throw new Error("Missing Facebook object id");
  const body = {
    is_published: true,
    timeline_visibility: "normal",
  };
  const unix = Number(scheduledUnixSec);
  if (Number.isFinite(unix) && unix > 0) {
    // Giữ mốc giờ hẹn trên timeline (tránh hiện "vừa đăng")
    body.backdated_time = Math.floor(unix);
  }
  try {
    return await graphPostJson(`/${objectId}`, pageToken, body, metaAppKey);
  } catch (e) {
    // Video object đôi khi không nhận backdated_time — thử tối thiểu
    if (body.backdated_time != null) {
      try {
        return await graphPostJson(
          `/${objectId}`,
          pageToken,
          { is_published: true, timeline_visibility: "normal" },
          metaAppKey
        );
      } catch {
        /* fall through */
      }
    }
    // published=true alternate (một số edge video)
    try {
      return await graphPostJson(
        `/${objectId}`,
        pageToken,
        { published: true },
        metaAppKey
      );
    } catch {
      throw e;
    }
  }
}

/** Enrich post/video id → permalink + publish flags (best-effort). */
export async function enrichPublishResult(objectId, pageToken, base = {}) {
  if (!objectId) return base;
  try {
    const st = await getFacebookPostStatus(objectId, pageToken);
    const permalink =
      st.permalink_url || st.link || base.post_url || null;
    return {
      ...base,
      post_id: base.post_id || st.id || objectId,
      post_url: permalink || (objectId ? `https://www.facebook.com/${objectId}` : base.post_url),
      is_published: st.is_published,
      is_hidden: st.is_hidden,
      permalink_url: permalink,
      raw_status: st,
    };
  } catch {
    return base;
  }
}

/** Text post on Page feed (or schedule via schedule.scheduled_publish_time) */
export async function publishText(pageId, pageToken, message, schedule = null) {
  const data = await graphPostJson(`/${pageId}/feed`, pageToken, {
    message: message || "",
    ...scheduleFields(schedule, { kind: "text" }),
  });
  const postId = data.id || null;
  const base = {
    post_id: postId,
    post_url: postId ? `https://www.facebook.com/${postId}` : null,
    scheduled: !!schedule?.scheduled_publish_time,
    scheduled_publish_time: schedule?.scheduled_publish_time
      ? Number(schedule.scheduled_publish_time)
      : null,
    raw: data,
  };
  return enrichPublishResult(postId, pageToken, base);
}

/** Photo post — local file required */
export async function publishPhoto(
  pageId,
  pageToken,
  filePath,
  caption = "",
  schedule = null
) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const data = await graphPostForm(
    `/${pageId}/photos`,
    pageToken,
    {
      caption: caption || "",
      ...scheduleFields(schedule, { kind: "photo" }),
    },
    { name: "source", filePath }
  );
  // photos return { id: photo_id, post_id?: ... }
  const postId = data.post_id || data.id || null;
  const base = {
    post_id: postId,
    photo_id: data.id || null,
    post_url: postId ? `https://www.facebook.com/${postId}` : null,
    scheduled: !!schedule?.scheduled_publish_time,
    scheduled_publish_time: schedule?.scheduled_publish_time
      ? Number(schedule.scheduled_publish_time)
      : null,
    raw: data,
  };
  // Prefer post_id for status/permalink (photo node ≠ feed post)
  return enrichPublishResult(data.post_id || postId, pageToken, base);
}

/**
 * Meta video `title` hard limit 255 — Graph often counts UTF-8 **bytes**
 * (tiếng Việt/emoji: 255 ký tự có thể > 255 byte → lỗi #100).
 * Clamp by bytes; giữ title ngắn (caption full nằm ở description).
 */
export function clampMetaVideoTitle(raw, maxBytes = 255) {
  let s = String(raw ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  if (!s) return "";
  // Chỉ 1 dòng — title ≠ caption dài nhiều dòng
  const firstLine = s.split("\n").map((l) => l.trim()).find(Boolean) || s;
  s = firstLine.replace(/\s+/g, " ").trim();
  // Soft cap ký tự rồi siết theo byte
  const chars = Array.from(s);
  if (chars.length > 200) s = chars.slice(0, 200).join("");
  let out = "";
  for (const ch of Array.from(s)) {
    const next = out + ch;
    if (Buffer.byteLength(next, "utf8") > maxBytes) break;
    out = next;
  }
  return out;
}

function isTitleLengthError(err) {
  const msg = String(err?.message || err?.fb?.message || "");
  return (
    /title/i.test(msg) &&
    (/255|less than or equal|must be less|length of param title/i.test(msg) ||
      err?.code === 100 ||
      err?.fb?.code === 100)
  );
}

/**
 * Video post — local file.
 * @param {string} description caption FULL (lead + link + body) → Graph `description`
 * @param {object|null} schedule
 * @param {{ title?: string|null }} [opts] title ngắn tùy chọn (kho title); không gửi nếu trống
 */
export async function publishVideo(
  pageId,
  pageToken,
  filePath,
  description = "",
  schedule = null,
  opts = {}
) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  // Caption bài = description FULL. Title Meta — clamp byte ≤255, không copy caption dài.
  const desc = description ? String(description) : "";
  let title = clampMetaVideoTitle(opts?.title);
  const baseFields = {
    description: desc,
    secret: "false",
    no_story: "false",
    embeddable: "true",
    ...scheduleFields(schedule, { kind: "video" }),
  };

  const postOnce = async (withTitle) => {
    const fields = {
      ...baseFields,
      ...(withTitle && title ? { title } : {}),
    };
    return graphPostForm(
      `/${pageId}/videos`,
      pageToken,
      fields,
      { name: "source", filePath }
    );
  };

  let data;
  try {
    data = await postOnce(!!title);
  } catch (e) {
    // Title vẫn fail (kho trỏ nhầm caption dài / Meta đếm lạ) → đăng lại không title
    if (title && isTitleLengthError(e)) {
      console.warn(
        "[publishVideo] title rejected by Meta, retry without title:",
        e.message
      );
      title = "";
      data = await postOnce(false);
    } else {
      throw e;
    }
  }

  const postId = data.id || data.post_id || null;
  const base = {
    post_id: postId,
    post_url: postId ? `https://www.facebook.com/${postId}` : null,
    scheduled: !!schedule?.scheduled_publish_time,
    scheduled_publish_time: schedule?.scheduled_publish_time
      ? Number(schedule.scheduled_publish_time)
      : null,
    video_title: title || null,
    raw: data,
  };
  return enrichPublishResult(postId, pageToken, base);
}

/** List posts scheduled on Page (Graph: /{page-id}/scheduled_posts) */
export async function listScheduledPosts(pageId, pageToken, limit = 50) {
  const url = new URL(`${graphBase()}/${pageId}/scheduled_posts`);
  url.searchParams.set("access_token", pageToken);
  url.searchParams.set(
    "fields",
    "id,message,created_time,scheduled_publish_time,status_type,permalink_url"
  );
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url);
  noteGraphResponse(res);
  const data = await res.json();
  if (data.error) {
    const err = new Error(data.error.message || "List scheduled_posts failed");
    err.code = data.error.code;
    err.fb = data.error;
    throw err;
  }
  return data.data || [];
}

/** Read one scheduled/published object to reconcile local log status. */
export async function getFacebookPostStatus(postId, pageToken) {
  if (!postId) throw new Error("Missing Facebook post id");
  try {
    return await graphGetJson(
      `/${postId}`,
      pageToken,
      "id,created_time,permalink_url,is_published,is_hidden,scheduled_publish_time,status_type,from,reactions.summary(true).limit(0),likes.summary(true).limit(0)"
    );
  } catch (e) {
    // Fallback without engagement fields (permission / API variance)
    try {
      return await graphGetJson(
        `/${postId}`,
        pageToken,
        "id,created_time,permalink_url,is_published,is_hidden,scheduled_publish_time,status_type"
      );
    } catch (e2) {
      if (Number(e2.code) !== 100 && Number(e.code) !== 100) throw e2;
      const basic = await graphGetJson(
        `/${postId}`,
        pageToken,
        "id,created_time,link"
      );
      if (!basic.permalink_url && basic.link) basic.permalink_url = basic.link;
      return basic;
    }
  }
}

/** Best-effort like/reaction count from a post status payload. */
export function extractPostLikeCount(fb) {
  if (!fb || typeof fb !== "object") return 0;
  const reactions = Number(fb.reactions?.summary?.total_count);
  if (Number.isFinite(reactions) && reactions >= 0) return reactions;
  const likes = Number(fb.likes?.summary?.total_count);
  if (Number.isFinite(likes) && likes >= 0) return likes;
  return 0;
}

/** Comment as Page on a post */
export async function publishComment(postId, pageToken, message) {
  if (!postId) throw new Error("Missing post_id for comment");
  if (!message) throw new Error("Empty comment");
  // post id may be "pageId_postId" or just id
  const data = await graphPostJson(`/${postId}/comments`, pageToken, {
    message,
  });
  return {
    comment_id: data.id || null,
    raw: data,
  };
}

export function isImageFile(filePath) {
  return /\.(jpe?g|png|gif|bmp|webp|tiff?)$/i.test(filePath);
}

export function isVideoFile(filePath) {
  return /\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(filePath);
}
