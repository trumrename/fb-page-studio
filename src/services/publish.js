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
import { resolveExistingMediaPath } from "./mediaLibrary.js";
import { formatFbNotice, graphError } from "./fbNotice.js";

function withViLocale(url) {
  const u = url instanceof URL ? url : new URL(url);
  if (!u.searchParams.has("locale")) u.searchParams.set("locale", "vi_VN");
  return u;
}

function requireMediaFile(filePath, label = "media") {
  if (filePath && fs.existsSync(filePath)) return filePath;
  const found = resolveExistingMediaPath(filePath, []);
  if (found) return found;
  const err = new Error(`File not found: ${filePath}`);
  err.code = "MEDIA_FILE_MISSING";
  err.permanent = true;
  throw err;
}

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

/**
 * Graph đôi khi trả body rỗng (502/timeout/proxy) → res.json() ném
 * "Unexpected end of JSON input". Parse an toàn + đánh dấu network để retry.
 */
async function readGraphJson(res, label = "Graph") {
  const text = await res.text();
  const status = Number(res.status || 0);
  if (!text || !String(text).trim()) {
    const err = new Error(
      status === 413
        ? `Facebook từ chối upload (HTTP 413) — file quá lớn cho POST form (${label}). Cần upload chia đoạn.`
        : `Facebook trả về rỗng (HTTP ${status || "?"}) — ${label}. Thử lại.`
    );
    err.status = status;
    err.http_status = status;
    if (status === 413) {
      err.code = "PAYLOAD_TOO_LARGE";
      err.permanent = true;
      err.network = false;
    } else {
      err.code = "EMPTY_GRAPH_BODY";
      err.network = true;
    }
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error(
      `Facebook trả JSON lỗi (HTTP ${status || "?"}) — ${label}: ${String(text).slice(0, 120)}`
    );
    err.code = "BAD_GRAPH_JSON";
    err.network = true;
    err.status = status;
    err.http_status = status;
    err.cause = e;
    throw err;
  }
}

function isPayloadTooLargeError(err) {
  if (!err) return false;
  if (err.code === "PAYLOAD_TOO_LARGE" || err.permanent === true) {
    const st = Number(err.status ?? err.http_status ?? NaN);
    if (st === 413 || err.code === "PAYLOAD_TOO_LARGE") return true;
  }
  const st = Number(err.status ?? err.http_status ?? NaN);
  if (st === 413) return true;
  return /\bhttp\s*413\b|payload too large|request entity too large|file quá lớn cho POST form/i.test(
    String(err.message || "")
  );
}

/**
 * Do not retry a publish request automatically. A network failure can occur
 * after Facebook accepted the post, so resending would create duplicates.
 * The caller records the task as uncertain and leaves any retry to the user.
 */
async function withPublishRetry(fn) {
  return fn();
}

/**
 * @param {string} urlPath
 * @param {string} pageToken
 * @param {Record<string, any>} fields
 * @param {{ name: string, filePath?: string, buffer?: Buffer, filename?: string }|null} fileField
 * @param {string} metaAppKey
 * @param {{ baseUrl?: string, label?: string, retry?: boolean }} [opts]
 */
async function graphPostForm(
  urlPath,
  pageToken,
  fields = {},
  fileField = null,
  metaAppKey = "",
  opts = {}
) {
  const baseUrl = opts.baseUrl || graphBase();
  const label = opts.label || "POST form";
  const run = async () => {
    const tryOnce = async (withProof) => {
      const url = withViLocale(`${baseUrl}${urlPath}`).toString();
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
        const { name, filePath, buffer, filename } = fileField;
        let buf = buffer;
        let fname = filename;
        if (!buf && filePath) {
          buf = fs.readFileSync(filePath);
          fname = fname || path.basename(filePath);
        }
        if (!buf) throw new Error("graphPostForm: thiếu file/buffer");
        form.append(name, new Blob([buf]), fname || "upload.bin");
      }
      let res;
      try {
        const timeoutMs = fileField ? 180000 : 60000;
        res = await fetch(url, {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw wrapFetchError(e, label);
      }
      noteGraphResponse(res, pageToken);
      return readGraphJson(res, label);
    };
    let data = await tryOnce(true);
    if (data?.error && isInvalidAppSecretProofError(data.error.message)) {
      data = await tryOnce(false);
    }
    if (data.error) throw graphError(data.error, "Graph publish error");
    return data;
  };
  // Chunk transfer / 413 không nên retry vòng ngoài — caller xử lý
  if (opts.retry === false) return run();
  return withPublishRetry(run);
}

async function graphPostJson(urlPath, pageToken, body = {}, metaAppKey = "") {
  return withPublishRetry(async () => {
    const tryOnce = async (withProof) => {
      const url = withViLocale(new URL(`${graphBase()}${urlPath}`));
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
          signal: AbortSignal.timeout(60000),
        });
      } catch (e) {
        throw wrapFetchError(e, "POST json");
      }
      noteGraphResponse(res, pageToken);
      return readGraphJson(res, "POST json");
    };
    let data = await tryOnce(true);
    if (data?.error && isInvalidAppSecretProofError(data.error.message)) {
      data = await tryOnce(false);
    }
    if (data.error) throw graphError(data.error, "Graph publish error");
    return data;
  });
}

async function graphGetJson(urlPath, pageToken, fields, metaAppKey = "") {
  return withPublishRetry(async () => {
    const tryOnce = async (withProof) => {
      const url = withViLocale(new URL(`${graphBase()}${urlPath}`));
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
      noteGraphResponse(res, pageToken);
      return readGraphJson(res, "GET");
    };
    let data = await tryOnce(true);
    if (data?.error && isInvalidAppSecretProofError(data.error.message)) {
      data = await tryOnce(false);
    }
    if (data.error) throw graphError(data.error, "Graph read error");
    return data;
  });
}

export function validateScheduleUnix(unixSec, opts = {}) {
  const n = Number(unixSec);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("scheduled_publish_time không hợp lệ (cần UNIX seconds)");
  }
  const now = Math.floor(Date.now() / 1000);
  const min = now + 10 * 60;
  const maxDays = Number(opts.maxDays) === 29 ? 29 : 30;
  const max = now + maxDays * 24 * 60 * 60;
  if (n < min) {
    throw new Error(
      "Hẹn giờ phải cách hiện tại ≥ 10 phút (quy tắc Graph API)"
    );
  }
  if (n > max) {
    throw new Error(
      maxDays === 29
        ? "Hẹn Reel tối đa 29 ngày kể từ bây giờ (quy tắc Graph API)"
        : "Hẹn giờ tối đa 30 ngày kể từ bây giờ (quy tắc Graph API)"
    );
  }
  return Math.floor(n);
}

/**
 * @param {object} [schedule] { scheduled_publish_time: unixSec }
 * @param {{ kind?: 'photo'|'video'|'text' }} [opts]
 * Ảnh, video và text đều cần unpublished_content_type=SCHEDULED
 * thì bài mới hiện trong lịch hẹn của Page.
 */
function scheduleFields(schedule, opts = {}) {
  if (!schedule?.scheduled_publish_time) {
    return { published: "true" };
  }
  const t = validateScheduleUnix(schedule.scheduled_publish_time);
  // Ảnh đi multipart. Chữ "false" là chuỗi khác rỗng nên Graph có thể hiểu là bật.
  // Tài liệu feed JSON vẫn dùng chữ "false" — chữ giữ cho bài text.
  const published = opts.kind === "photo" ? "0" : "false";
  return {
    published,
    scheduled_publish_time: String(t),
    unpublished_content_type: "SCHEDULED",
  };
}

/**
 * Giá trị COUNTRY_RESTRICTIONS của Page.
 * @param {unknown} value
 * @returns {{ type: "whitelist"|"blacklist", countries: string[] }|null}
 */
export function parseCountryRestriction(value) {
  let parsed = value;
  if (typeof parsed === "string") {
    const s = parsed.trim();
    if (!s || s === "null" || s === "{}") return null;
    try {
      parsed = JSON.parse(s);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const typeRaw = String(parsed.restriction_type || parsed.type || "").toLowerCase();
  const type =
    typeRaw === "whitelist" || typeRaw === "whitelist_only"
      ? "whitelist"
      : typeRaw === "blacklist"
        ? "blacklist"
        : "";
  const rawCountries = parsed.countries || parsed.country || [];
  const list = Array.isArray(rawCountries) ? rawCountries : [rawCountries];
  const countries = [
    ...new Set(
      list
        .map((c) => String(c || "").trim().toUpperCase())
        .filter((c) => /^[A-Z]{2}$/.test(c))
    ),
  ];
  if (!type || !countries.length) return null;
  return { type, countries };
}

/**
 * Cờ video gửi lên Graph.
 * Chuỗi "false" có thể bị hiểu thành bật → video thành bài kín. Dùng 0/1.
 * Page blacklist đã chặn các nước đó với mọi bài. Không gắn excluded_countries
 * lên video: Facebook lưu quyền xem Tùy chỉnh, danh sách được xem trống,
 * rồi mọi nước đều không mở được. Whitelist vẫn gửi danh sách nước được xem.
 * @param {{ type: "whitelist"|"blacklist", countries: string[] }|null} restriction
 */
export function videoAudienceFields(restriction) {
  const fields = {
    secret: "0",
    no_story: "0",
  };
  if (!restriction || restriction.type !== "whitelist") {
    fields.embeddable = restriction ? "0" : "1";
    return fields;
  }
  fields.embeddable = "0";
  fields.targeting = JSON.stringify({
    geo_locations: { countries: restriction.countries },
  });
  return fields;
}

const pageCountryCache = new Map();

async function loadPageCountryRestriction(pageId, pageToken, metaAppKey) {
  const key = String(pageId || "");
  if (!key) return null;
  if (pageCountryCache.has(key)) return pageCountryCache.get(key);
  let parsed = null;
  try {
    const data = await graphGetJson(`/${key}/settings`, pageToken, "", metaAppKey);
    const row = (data?.data || []).find((x) => x && x.setting === "COUNTRY_RESTRICTIONS");
    parsed = parseCountryRestriction(row?.value);
  } catch (e) {
    console.warn(
      "[publishVideo] không đọc được chặn quốc gia page",
      key,
      e?.message || e
    );
    parsed = null;
  }
  pageCountryCache.set(key, parsed);
  return parsed;
}

function isAudienceParamError(err) {
  const msg = String(err?.message || err?.fb?.message || "");
  return (
    Number(err?.code ?? err?.fb?.code) === 100 &&
    /targeting|geo_location|excluded_countries|countries|overlap/i.test(msg)
  );
}

/** Facebook đôi khi trả câu lỗi file khi body video có thêm targeting quốc gia. */
export function videoUploadShouldDropTargeting(err, fields) {
  if (!fields?.targeting) return false;
  if (isAudienceParamError(err)) return true;
  return /problem uploading your video file/i.test(
    String(err?.message || err?.fb?.message || "")
  );
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

/** Chuẩn hóa permalink Graph thành URL tuyệt đối. */
export function absoluteFacebookUrl(url, postId = null) {
  const raw = String(url || "").trim();
  const id = postId != null ? String(postId).trim() : "";
  if (raw) {
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith("//")) return `https:${raw}`;
    if (raw.startsWith("/")) return `https://www.facebook.com${raw}`;
    if (/^(facebook\.com|fb\.watch|fb\.com|www\.facebook\.com)/i.test(raw)) {
      return raw.startsWith("http") ? raw : `https://${raw.replace(/^www\./i, "www.")}`;
    }
    return `https://www.facebook.com/${raw.replace(/^\/+/, "")}`;
  }
  if (!id) return null;
  return pageStoryUrl(id) || `https://www.facebook.com/${id}`;
}

/** facebook.com/{số} không mở được bài. */
export function isBareFacebookObjectUrl(url) {
  return /^https?:\/\/(?:www\.)?facebook\.com\/\d+\/?$/i.test(String(url || "").trim());
}

/** Permalink Graph của video là /reel/ — trình phát reel, không phải link bài trên page. */
export function isReelPermalink(url) {
  const raw = String(url || "").trim();
  return /facebook\.com\/reel\/\d+/i.test(raw) || /^\/reel\/\d+/i.test(raw);
}

/** Link bài video trên page. Cùng một dạng cho hẹn giờ và đăng trực tiếp. */
export function pageVideoUrl(pageId, videoId) {
  const page = String(pageId || "").trim();
  const video = String(videoId || "").trim();
  if (!/^\d+$/.test(page) || !/^\d+$/.test(video)) return null;
  return `https://www.facebook.com/${page}/videos/${video}`;
}

/** Id page_story → /{page}/posts/{story}. */
export function pageStoryUrl(postId) {
  const m = String(postId || "").trim().match(/^(\d+)_(\d+)$/);
  if (!m) return null;
  return `https://www.facebook.com/${m[1]}/posts/${m[2]}`;
}

/** Bài trên Page. Ảnh trả id này ngay. Reel hẹn giờ thường chỉ có video id. */
export function isPagePostId(id) {
  return /^\d+_\d+$/.test(String(id || "").trim());
}

/**
 * Chọn id để comment trên Reel.
 * Comment hiện trên Reel khi gửi vào post {page}_{post}, không phải video id lúc hẹn.
 * @param {string} videoId
 * @param {string} pageId
 * @param {object|null} node GET /{video-id}
 * @returns {{ postId: string, pending: boolean }}
 */
export function pickReelCommentPostId(videoId, pageId, node) {
  const id = String(videoId || "").trim();
  const page = String(pageId || "").trim();
  const data = node && typeof node === "object" ? node : {};
  if (isPagePostId(id)) return { postId: id, pending: false };

  const published = data.published;
  const notLive =
    published === false ||
    published === 0 ||
    published === "false" ||
    published === "0";

  let postId = "";
  const raw = data.post_id != null ? String(data.post_id).trim() : "";
  if (isPagePostId(raw)) postId = raw;
  else if (/^\d+$/.test(raw) && /^\d+$/.test(page) && raw !== id) postId = `${page}_${raw}`;

  if (!postId) {
    const perm = String(data.permalink_url || "");
    const posts = perm.match(/\/posts\/(\d+)/);
    const story = perm.match(/[?&]story_fbid=(\d+)/);
    const pageFromUrl = perm.match(/facebook\.com\/(\d+)/);
    const pageNum = /^\d+$/.test(page) ? page : pageFromUrl?.[1] || "";
    const storyNum = posts?.[1] || story?.[1] || "";
    if (/^\d+$/.test(pageNum) && /^\d+$/.test(storyNum) && storyNum !== id) {
      postId = `${pageNum}_${storyNum}`;
    }
  }

  if (!isPagePostId(postId) || notLive) return { postId: "", pending: true };
  return { postId, pending: false };
}

/**
 * Reel đã lên tường thì trả post id để comment.
 * Chưa có post thì lỗi retryable, không comment vào video id.
 */
export async function resolveReelCommentPost(objectId, pageToken, pageId = "") {
  const id = String(objectId || "").trim();
  if (isPagePostId(id)) return { postId: id, pending: false };
  if (!/^\d+$/.test(id)) {
    const err = new Error("Thiếu id Reel để comment");
    err.retryable = true;
    throw err;
  }
  const fieldSets = ["id,post_id,permalink_url,published", "id,post_id,published", "id,post_id"];
  let data = null;
  let lastErr = null;
  for (const fields of fieldSets) {
    try {
      data = await graphGetJson(`/${id}`, pageToken, fields);
      break;
    } catch (e) {
      lastErr = e;
      const code = Number(e?.code ?? e?.fb?.code ?? NaN);
      if (code === 190 || code === 10 || code === 200) throw e;
      const msg = String(e?.message || "");
      const fieldErr = code === 100 && /nonexisting field|unknown field/i.test(msg);
      if (!fieldErr && fields === fieldSets[fieldSets.length - 1]) break;
      if (!fieldErr && code !== 100) break;
    }
  }
  if (!data) {
    const err = new Error(lastErr?.message || "Facebook chưa trả bài Reel");
    err.retryable = true;
    err.fb = lastErr?.fb;
    err.code = lastErr?.code ?? lastErr?.fb?.code;
    throw err;
  }
  const picked = pickReelCommentPostId(id, pageId, data);
  if (!picked.postId) {
    const err = new Error("Reel chưa có bài trên trang để comment. Sẽ thử lại.");
    err.retryable = true;
    throw err;
  }
  return picked;
}

function usablePostUrl(url) {
  const abs = absoluteFacebookUrl(url);
  if (!abs || isBareFacebookObjectUrl(abs) || isReelPermalink(abs)) return null;
  return abs;
}

/** Giữ permalink mở được bài. Bỏ facebook.com/{id} và /reel/. */
export function preferRealPostUrl(candidate, fallback = null) {
  return usablePostUrl(candidate) || usablePostUrl(fallback) || null;
}

function scheduleIsFuture(schedule) {
  const unix = Number(schedule?.scheduled_publish_time);
  return Number.isFinite(unix) && unix * 1000 > Date.now() + 15_000;
}

/** Enrich post/video id → permalink + publish flags (best-effort). */
export async function enrichPublishResult(objectId, pageToken, base = {}) {
  if (!objectId) return base;
  try {
    const st = await getFacebookPostStatus(objectId, pageToken);
    const permalink =
      absoluteFacebookUrl(st.permalink_url || st.link || base.post_url || null, objectId);
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
  const storyUrl = pageStoryUrl(postId);
  const base = {
    post_id: postId,
    post_url: storyUrl || (postId ? `https://www.facebook.com/${postId}` : null),
    scheduled: !!schedule?.scheduled_publish_time,
    scheduled_publish_time: schedule?.scheduled_publish_time
      ? Number(schedule.scheduled_publish_time)
      : null,
    raw: data,
  };
  if (scheduleIsFuture(schedule)) return base;
  const enriched = await enrichPublishResult(postId, pageToken, base);
  return {
    ...enriched,
    post_url: preferRealPostUrl(enriched.post_url, storyUrl) || enriched.post_url,
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
  filePath = requireMediaFile(filePath, "photo");
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
  const storyUrl = pageStoryUrl(postId);
  const photoId = data.id != null ? String(data.id).trim() : "";
  const photoUrl =
    !storyUrl && /^\d+$/.test(photoId)
      ? `https://www.facebook.com/photo.php?fbid=${photoId}&set=p.${photoId}&type=3`
      : null;
  const base = {
    post_id: postId,
    photo_id: data.id || null,
    post_url: storyUrl || photoUrl || (postId ? `https://www.facebook.com/${postId}` : null),
    scheduled: !!schedule?.scheduled_publish_time,
    scheduled_publish_time: schedule?.scheduled_publish_time
      ? Number(schedule.scheduled_publish_time)
      : null,
    raw: data,
  };
  if (scheduleIsFuture(schedule)) return base;
  const enriched = await enrichPublishResult(data.post_id || postId, pageToken, base);
  return {
    ...enriched,
    post_url: preferRealPostUrl(enriched.post_url, base.post_url) || enriched.post_url,
  };
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

const REEL_API_LIMIT_24H = 30;
const reelInFlight = new Map();

function explainReelError(err) {
  const blob = [
    err?.fb?.error_subcode,
    err?.code,
    err?.fb?.code,
    err?.message,
    err?.fb?.message,
    err?.fb?.error_user_msg,
  ]
    .filter((x) => x != null && x !== "")
    .join(" ");
  let hint = "";
  if (/\b1363040\b|aspect ratio/i.test(blob)) {
    hint = "Reel cần tỉ lệ 9:16 (tối thiểu khung 540×960).";
  } else if (/\b1363127\b|resolution too low|minimum resolution/i.test(blob)) {
    hint = "Reel tối thiểu 540×960, nên 1080×1920.";
  } else if (/\b1363128\b|duration/i.test(blob)) {
    hint = "Reel phải dài từ 3 đến 90 giây.";
  } else if (/\b1363129\b|frame rate/i.test(blob)) {
    hint = "Reel cần 24–60 khung hình mỗi giây.";
  } else if (Number(err?.code ?? err?.fb?.code) === 613) {
    hint = "Page đã chạm 30 Reel API trong 24 giờ.";
  }
  if (!hint) return err;
  const wrapped = new Error(`${hint} ${err?.message || ""}`.trim());
  wrapped.code = err?.code ?? err?.fb?.code;
  wrapped.fb = err?.fb;
  wrapped.permanent = true;
  return wrapped;
}

async function countRecentReelPosts(pageId) {
  const id = String(pageId || "").trim();
  if (!id) return 0;
  try {
    const { getDb } = await import("../db/index.js");
    const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const cutoffSql = cutoffIso.slice(0, 19).replace("T", " ");
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM post_logs
         WHERE page_id = ?
           AND lower(COALESCE(post_type, '')) = 'video'
           AND status IN ('ok','ok_comment_failed','scheduled','published','schedule_overdue')
           AND (
             created_at >= ?
             OR replace(substr(created_at, 1, 19), 'T', ' ') >= ?
           )`
      )
      .get(id, cutoffIso, cutoffSql);
    return Number(row?.n || 0);
  } catch (e) {
    console.warn("[publishVideo] không đếm được Reel 24 giờ", e?.message || e);
    return 0;
  }
}

async function reserveReelSlot(pageId) {
  const id = String(pageId || "");
  const inflight = reelInFlight.get(id) || 0;
  const recent = await countRecentReelPosts(id);
  if (recent + inflight >= REEL_API_LIMIT_24H) {
    const err = new Error(
      "Page đã đủ 30 Reel API trong 24 giờ (quy tắc Facebook). Chờ hết cửa sổ 24 giờ rồi đăng tiếp."
    );
    err.permanent = true;
    err.code = 613;
    throw err;
  }
  reelInFlight.set(id, inflight + 1);
  return () => {
    const n = (reelInFlight.get(id) || 1) - 1;
    if (n <= 0) reelInFlight.delete(id);
    else reelInFlight.set(id, n);
  };
}

export function reelUploadHeaders(fileSize, startAt, byteLength) {
  return {
    offset: String(startAt),
    file_size: String(fileSize),
    "Content-Type": "application/octet-stream",
    "Content-Length": String(byteLength),
    "X-Entity-Length": String(fileSize),
  };
}

async function readReelSlice(filePath, startAt, fileSize) {
  const length = fileSize - startAt;
  if (length <= 0) {
    throw new Error("Upload Reel: offset vượt quá dung lượng file");
  }
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, startAt);
    if (bytesRead !== length) {
      throw new Error("Upload Reel: không đọc đủ file");
    }
    return buf;
  } finally {
    await handle.close();
  }
}

async function uploadReelBinary(uploadUrl, filePath, pageToken, offset = 0) {
  const fileSize = fs.statSync(filePath).size;
  const startAt = Math.max(0, Math.floor(Number(offset) || 0));
  const body = await readReelSlice(filePath, startAt, fileSize);
  let upRes;
  try {
    upRes = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `OAuth ${pageToken}`,
        ...reelUploadHeaders(fileSize, startAt, body.length),
      },
      body,
      signal: AbortSignal.timeout(600000),
    });
  } catch (e) {
    throw wrapFetchError(e, "reel upload");
  }
  const rawText = await upRes.text();
  const scrubbed = rawText.replace(/access_token=[^&\s]+/gi, "access_token=***");
  let data = {};
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = {};
  }
  if (!upRes.ok || data.success === false || data.error) {
    const detail = String(
      data?.error?.message || data?.debug_info?.message || scrubbed
    ).slice(0, 180);
    const err = new Error(
      `Upload Reel lỗi HTTP ${upRes.status}${detail ? `: ${detail}` : ""}`
    );
    err.fb = data.error || null;
    err.permanent = true;
    throw err;
  }
  if (data.success !== true) {
    const err = new Error(
      `Upload Reel không trả success${scrubbed ? `: ${scrubbed.slice(0, 180)}` : ""}`
    );
    err.permanent = true;
    throw err;
  }
  return data;
}

async function waitReelUploadReady(videoId, pageToken, metaAppKey) {
  let last = null;
  for (let i = 0; i < 30; i++) {
    try {
      const st = await graphGetJson(`/${videoId}`, pageToken, "status", metaAppKey);
      last = st?.status || {};
      const uploading = String(last.uploading_phase?.status || "");
      const videoStatus = String(last.video_status || "");
      const procErr = last.processing_phase?.error?.message;
      if (videoStatus === "error" || videoStatus === "upload_failed" || uploading === "error") {
        const err = new Error(procErr || "Facebook báo file Reel lỗi");
        err.permanent = true;
        throw err;
      }
      if (uploading === "complete" || videoStatus === "upload_complete" || videoStatus === "ready") {
        if (procErr) {
          const err = new Error(procErr);
          err.permanent = true;
          throw err;
        }
        return last;
      }
    } catch (e) {
      if (e?.permanent) throw e;
    }
    await sleep(2000);
  }
  const err = new Error("Facebook chưa nhận xong file Reel");
  err.permanent = true;
  err.status = last;
  throw err;
}

/**
 * Đăng hoặc hẹn Reel: POST /{page-id}/video_reels.
 * start JSON → rupload octet-stream → đợi uploading_phase=complete → finish.
 * video_state=PUBLISHED hoặc SCHEDULED. Không gửi secret/no_story.
 */
async function publishScheduledReel(pageId, pageToken, filePath, description, unixSec, title, metaAppKey = "", videoState = "SCHEDULED", targeting = null) {
  const release = await reserveReelSlot(pageId);
  try {
    const start = await graphPostJson(
      `/${pageId}/video_reels`,
      pageToken,
      { upload_phase: "start" },
      metaAppKey
    );
    const videoId = String(start.video_id || "").trim();
    const uploadUrl = String(start.upload_url || "").trim();
    if (!/^\d+$/.test(videoId) || !uploadUrl) {
      throw new Error("Facebook không trả phiên upload Reel để hẹn");
    }
    try {
      await uploadReelBinary(uploadUrl, filePath, pageToken, 0);
    } catch (e) {
      const msg = String(e?.message || "");
      if (!/OffsetInvalid|starting offset is invalid/i.test(msg)) throw explainReelError(e);
      const st = await graphGetJson(`/${videoId}`, pageToken, "status", metaAppKey);
      const bytes = Number(st?.status?.uploading_phase?.bytes_transfered);
      if (!Number.isFinite(bytes) || bytes <= 0) throw explainReelError(e);
      await uploadReelBinary(uploadUrl, filePath, pageToken, bytes);
    }
    await waitReelUploadReady(videoId, pageToken, metaAppKey);
    const state = videoState === "PUBLISHED" ? "PUBLISHED" : "SCHEDULED";
    const fields = {
      upload_phase: "finish",
      video_id: videoId,
      video_state: state,
      description: description || "",
    };
    if (state === "SCHEDULED") {
      fields.scheduled_publish_time = String(Math.floor(Number(unixSec)));
    }
    if (title) fields.title = title;
    if (targeting) fields.targeting = targeting;
    let finish;
    try {
      finish = await graphPostForm(
        `/${pageId}/video_reels`,
        pageToken,
        fields,
        null,
        metaAppKey,
        { label: "reel finish" }
      );
    } catch (e) {
      throw explainReelError(e);
    }
    if (finish?.success === false) {
      throw new Error(finish.message || "Facebook không nhận finish Reel");
    }
    return {
      videoId,
      postId: finish.post_id ? String(finish.post_id) : "",
      raw: finish,
    };
  } finally {
    release();
  }
}

/**
 * Video post — local file.
 * File nhỏ: POST form 1 phát. File lớn / HTTP 413: upload chia đoạn (resumable).
 * Hẹn giờ đi /video_reels với video_state=SCHEDULED.
 * @param {string} description caption FULL (lead + link + body) → Graph `description`
 * @param {object|null} schedule
 * @param {{ title?: string|null, metaAppKey?: string }} [opts] title ngắn tùy chọn (kho title); không gửi nếu trống
 */
export async function publishVideo(
  pageId,
  pageToken,
  filePath,
  description = "",
  schedule = null,
  opts = {}
) {
  filePath = requireMediaFile(filePath, "video");
  // Caption bài = description FULL. Title Meta — clamp byte ≤255, không copy caption dài.
  const desc = description ? String(description) : "";
  let title = clampMetaVideoTitle(opts?.title);
  const metaAppKey = opts?.metaAppKey || "";
  // Hẹn giờ = Reel video_state=SCHEDULED. Đăng trực tiếp không gắn excluded_countries.
  const scheduling = !!schedule?.scheduled_publish_time;
  if (scheduling) {
    const unix = validateScheduleUnix(schedule.scheduled_publish_time, { maxDays: 29 });
    let reel;
    try {
      reel = await publishScheduledReel(pageId, pageToken, filePath, desc, unix, title, metaAppKey);
    } catch (e) {
      if (!(title && isTitleLengthError(e))) throw e;
      title = "";
      reel = await publishScheduledReel(pageId, pageToken, filePath, desc, unix, "", metaAppKey);
    }
    const storyId = /^\d+_\d+$/.test(reel.postId) ? reel.postId : "";
    const postId = storyId || reel.videoId;
    return {
      post_id: postId,
      post_url: pageStoryUrl(storyId) || pageVideoUrl(pageId, reel.videoId),
      scheduled: true,
      scheduled_publish_time: unix,
      video_title: title || null,
      upload_mode: "reel",
      raw: reel.raw,
    };
  }
  const restriction = await loadPageCountryRestriction(pageId, pageToken, metaAppKey);
  let targeting = null;
  if (restriction?.type === "whitelist" && restriction.countries?.length) {
    targeting = JSON.stringify({ geo_locations: { countries: restriction.countries } });
  }
  const postReel = (useTitle, useTargeting) =>
    publishScheduledReel(
      pageId,
      pageToken,
      filePath,
      desc,
      0,
      useTitle ? title : "",
      metaAppKey,
      "PUBLISHED",
      useTargeting ? targeting : null
    );
  let reel;
  try {
    reel = await postReel(!!title, !!targeting);
  } catch (e) {
    if (targeting && videoUploadShouldDropTargeting(e, { targeting })) {
      console.warn(
        "[publishVideo] Facebook từ chối Reel kèm targeting quốc gia, đăng lại không gắn thêm:",
        e.message
      );
      targeting = null;
      try {
        reel = await postReel(!!title, false);
      } catch (e2) {
        if (!(title && isTitleLengthError(e2))) throw e2;
        title = "";
        reel = await postReel(false, false);
      }
    } else if (title && isTitleLengthError(e)) {
      title = "";
      reel = await postReel(false, !!targeting);
    } else {
      throw e;
    }
  }
  const storyId = /^\d+_\d+$/.test(reel.postId) ? reel.postId : "";
  return {
    post_id: storyId || reel.videoId,
    post_url: pageStoryUrl(storyId) || pageVideoUrl(pageId, reel.videoId),
    scheduled: false,
    scheduled_publish_time: null,
    video_title: title || null,
    upload_mode: "reel",
    raw: reel.raw,
  };
}

/** List posts scheduled on Page (Graph: /{page-id}/scheduled_posts) */
export async function listScheduledPosts(pageId, pageToken, limit = 50) {
  const url = withViLocale(new URL(`${graphBase()}/${pageId}/scheduled_posts`));
  url.searchParams.set("access_token", pageToken);
  url.searchParams.set(
    "fields",
    "id,message,created_time,scheduled_publish_time,status_type,permalink_url"
  );
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url);
  noteGraphResponse(res, pageToken);
  const data = await readGraphJson(res, "list scheduled_posts");
  if (data.error) throw graphError(data.error, "List scheduled_posts failed");
  return data.data || [];
}

/** Read one scheduled/published object to reconcile local log status. */
export async function getFacebookPostStatus(postId, pageToken) {
  if (!postId) throw new Error("Missing Facebook post id");
  // Video objects often reject `link` (#100). Never rely on `link` as last fallback.
  const fieldSets = [
    "id,created_time,permalink_url,is_published,is_hidden,scheduled_publish_time,status_type,from,reactions.summary(true).limit(0),likes.summary(true).limit(0)",
    "id,created_time,permalink_url,is_published,is_hidden,scheduled_publish_time,status_type",
    "id,created_time,permalink_url,is_published,is_hidden,scheduled_publish_time",
    "id,created_time,permalink_url,is_published,status_type",
    "id,created_time,permalink_url",
    "id,permalink_url",
    "id",
  ];
  let lastErr = null;
  for (const fields of fieldSets) {
    try {
      return await graphGetJson(`/${postId}`, pageToken, fields);
    } catch (e) {
      lastErr = e;
      // Only continue fallback on field/permission style errors
      const code = Number(e?.code ?? e?.fb?.code ?? NaN);
      if (code !== 100 && code !== 10 && code !== 200 && !/nonexisting field|unknown field|permission/i.test(String(e?.message || ""))) {
        throw e;
      }
    }
  }
  throw lastErr || new Error(`Không đọc được object ${postId}`);
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

function firstCommentUrl(message) {
  const match = String(message || "").match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return "";
  return match[0].replace(/[)\].,;!?]+$/g, "");
}

/** Graph từ chối field preview. Không gồm chặn spam / limit — những lỗi đó không gửi lại. */
function attachmentShareRejected(err) {
  const code = Number(err?.code ?? err?.fb?.code ?? NaN);
  if ([4, 17, 32, 368, 613].includes(code)) return false;
  const msg = String(err?.fb?.error_user_msg || err?.fb?.message || err?.message || "");
  if (/bảo vệ cộng đồng khỏi spam|protect the community from spam|limit how often you can post/i.test(msg)) {
    return false;
  }
  return /attachment/i.test(msg);
}

/** Ghi vào post_logs.error khi comment lên nhưng không có thẻ preview. */
export const COMMENT_PREVIEW_FALLBACK_NOTE =
  "Comment OK nhưng mất thẻ preview (Graph từ chối attachment → gửi chỉ chữ)";

/** Delay giữa các lần thử lại vẫn kèm attachment_share_url (ms). */
const ATTACHMENT_RETRY_DELAYS_MS = [2000, 5000];

/**
 * Comment của Page. Link trong câu giữ nguyên.
 * attachment_share_url là thẻ xem trước của web, không phải ảnh đính kèm.
 * Có URL: thử kèm attachment (lần đầu + retry), chỉ khi vẫn bị từ chối mới gửi message-only
 * và trả preview_fallback=true để caller ghi log.
 */
export async function publishComment(postId, pageToken, message) {
  if (!postId) throw new Error("Missing post_id for comment");
  if (!message) throw new Error("Empty comment");
  const shareUrl = firstCommentUrl(message);
  const body = { message };
  if (shareUrl) body.attachment_share_url = shareUrl;

  const attachmentTries = shareUrl ? 1 + ATTACHMENT_RETRY_DELAYS_MS.length : 1;
  let lastAttachmentErr = null;

  for (let i = 0; i < attachmentTries; i++) {
    try {
      const data = await graphPostJson(`/${postId}/comments`, pageToken, body);
      return {
        comment_id: data.id || null,
        raw: data,
        preview_fallback: false,
        attachment_attempts: i + 1,
      };
    } catch (e) {
      if (!shareUrl || !attachmentShareRejected(e)) throw e;
      lastAttachmentErr = e;
      const detail = String(e?.fb?.error_user_msg || e?.fb?.message || e?.message || e);
      console.warn(
        `[publishComment] attachment_share_url bị từ chối (${i + 1}/${attachmentTries}): ${detail}`
      );
      if (i < attachmentTries - 1) {
        await sleep(ATTACHMENT_RETRY_DELAYS_MS[i] || 3000);
      }
    }
  }

  console.warn(
    `[publishComment] fallback message-only (mất thẻ preview): ${String(
      lastAttachmentErr?.fb?.error_user_msg ||
        lastAttachmentErr?.fb?.message ||
        lastAttachmentErr?.message ||
        lastAttachmentErr ||
        ""
    )}`
  );
  const data = await graphPostJson(`/${postId}/comments`, pageToken, { message });
  return {
    comment_id: data.id || null,
    raw: data,
    preview_fallback: true,
    attachment_attempts: attachmentTries,
    attachment_error: formatFbNotice(lastAttachmentErr),
  };
}

export function isImageFile(filePath) {
  return /\.(jpe?g|png|gif|bmp|webp|tiff?)$/i.test(filePath);
}

export function isVideoFile(filePath) {
  return /\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(filePath);
}
