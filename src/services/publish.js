/**
 * Official Graph API publish to Facebook Pages (feed only).
 * Story: not implemented here — config flag only.
 * Never invent success — always return Graph error text on failure.
 */
import fs from "fs";
import path from "path";
import { Blob } from "buffer";
import { graphBase } from "../config.js";
import { noteGraphResponse } from "./rateLimit.js";
import {
  appsecretProof,
  isInvalidAppSecretProofError,
  resolveAppSecret,
} from "./facebook.js";

function proofForToken(pageToken, metaAppKey = "") {
  const secret = resolveAppSecret("", metaAppKey);
  return appsecretProof(pageToken, secret);
}

async function graphPostForm(urlPath, pageToken, fields = {}, fileField = null, metaAppKey = "") {
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
    const res = await fetch(url, { method: "POST", body: form });
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
}

async function graphPostJson(urlPath, pageToken, body = {}, metaAppKey = "") {
  const tryOnce = async (withProof) => {
    const url = new URL(`${graphBase()}${urlPath}`);
    url.searchParams.set("access_token", pageToken);
    if (withProof) {
      const proof = proofForToken(pageToken, metaAppKey);
      if (proof) url.searchParams.set("appsecret_proof", proof);
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
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
}

async function graphGetJson(urlPath, pageToken, fields, metaAppKey = "") {
  const tryOnce = async (withProof) => {
    const url = new URL(`${graphBase()}${urlPath}`);
    url.searchParams.set("access_token", pageToken);
    if (withProof) {
      const proof = proofForToken(pageToken, metaAppKey);
      if (proof) url.searchParams.set("appsecret_proof", proof);
    }
    if (fields) url.searchParams.set("fields", fields);
    const res = await fetch(url);
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
}

/**
 * Validate FB scheduled_publish_time rules:
 * must be between 10 minutes and 30 days from now (unix seconds).
 */
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
 *   When set → published=false + scheduled_publish_time (FB Page scheduler).
 */
function scheduleFields(schedule) {
  if (!schedule?.scheduled_publish_time) return { published: "true" };
  const t = validateScheduleUnix(schedule.scheduled_publish_time);
  return {
    published: "false",
    scheduled_publish_time: String(t),
  };
}

/** Text post on Page feed (or schedule via schedule.scheduled_publish_time) */
export async function publishText(pageId, pageToken, message, schedule = null) {
  const data = await graphPostJson(`/${pageId}/feed`, pageToken, {
    message: message || "",
    ...scheduleFields(schedule),
  });
  return {
    post_id: data.id || null,
    post_url: data.id ? `https://www.facebook.com/${data.id}` : null,
    scheduled: !!schedule?.scheduled_publish_time,
    scheduled_publish_time: schedule?.scheduled_publish_time
      ? Number(schedule.scheduled_publish_time)
      : null,
    raw: data,
  };
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
      ...scheduleFields(schedule),
    },
    { name: "source", filePath }
  );
  // photos return { id: photo_id, post_id?: ... }
  const postId = data.post_id || data.id || null;
  return {
    post_id: postId,
    photo_id: data.id || null,
    post_url: postId ? `https://www.facebook.com/${postId}` : null,
    scheduled: !!schedule?.scheduled_publish_time,
    scheduled_publish_time: schedule?.scheduled_publish_time
      ? Number(schedule.scheduled_publish_time)
      : null,
    raw: data,
  };
}

/** Video post — local file */
export async function publishVideo(
  pageId,
  pageToken,
  filePath,
  description = "",
  schedule = null
) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const data = await graphPostForm(
    `/${pageId}/videos`,
    pageToken,
    {
      description: description || "",
      ...scheduleFields(schedule),
    },
    { name: "source", filePath }
  );
  const postId = data.id || data.post_id || null;
  return {
    post_id: postId,
    post_url: postId ? `https://www.facebook.com/${postId}` : null,
    scheduled: !!schedule?.scheduled_publish_time,
    scheduled_publish_time: schedule?.scheduled_publish_time
      ? Number(schedule.scheduled_publish_time)
      : null,
    raw: data,
  };
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
      "id,created_time,permalink_url,is_published,scheduled_publish_time,status_type"
    );
  } catch (e) {
    if (Number(e.code) !== 100) throw e;
    const basic = await graphGetJson(
      `/${postId}`,
      pageToken,
      "id,created_time,link"
    );
    if (!basic.permalink_url && basic.link) basic.permalink_url = basic.link;
    return basic;
  }
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
