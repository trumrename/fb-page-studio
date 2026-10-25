/**
 * Orchestrate one feed/story post for a page: media + caption + optional comment + CSV/DB log.
 * Story: Page Stories API (photo/video) + link strategy (combo/overlay) — no official link sticker.
 */
import fs from "fs";
import path from "path";
import { getDb } from "../db/index.js";
import { config } from "../config.js";
import { decryptToken } from "./crypto.js";
import {
  publishText,
  publishPhoto,
  publishVideo,
  publishComment,
  COMMENT_PREVIEW_FALLBACK_NOTE,
  isImageFile,
  isVideoFile,
} from "./publish.js";
import { publishPageStoryWithLink } from "./pageStories.js";
import {
  pickMedia,
  moveToPosted,
  pickCaption,
  captionModeForRun,
  composeCaptionWithLead,
  buildComment,
  assignCommentForPost,
  ensureCommentHasLink,
  ensureDir,
  listMediaFiles,
  captionPoolStats,
  loadCaptionsFromDisk,
} from "./mediaLibrary.js";
import * as mediaLibrary from "./mediaLibrary.js";
import { pickNextVideoTitle } from "./videoTitlePool.js";
import { applyMentionsToText } from "./mentions.js";
import { appendPostCsv } from "./postLogCsv.js";
import { isCommunitySpamBlock, isGraphRateLimitError, isSpamBlockError, isPermissionError } from "./rateLimit.js";
import { isPageCircuitOpen, openPageCircuit } from "./antiSpam.js";
import { formatFbNotice } from "./fbNotice.js";
import { commentDueIso, readCommentTiming } from "./commentTiming.js";
import {
  assertCanPublish,
  pickUnusedMedia,
  finalizeMediaAfterSuccess,
  releaseInflightMedia,
  countUnusedMedia,
  noteGraphFailure,
  clampPageLimits,
  ensureAntiSpamTables,
  getAntiSpamSettings,
  normalizeCaption,
} from "./antiSpam.js";
import { assertCanPublish as assertLicenseActive } from "./license.js";
import { withPageOperationLock } from "./pageOperationLock.js";
import { getAppSetting, saveAppSetting } from "./appSettings.js";
import {
  archiveBundleInbox,
  bundleLinkFolder,
  linkLineOrdinal,
  noteSharedBundleOrdinal,
  rememberArchivedLinkLines,
  shouldArchiveBundleNow,
} from "./bundleArchive.js";
import { reserveCaptionSlot } from "./captionPoolState.js";
import {
  countPagePostsOnLocalDay,
  isWithinPreferredWindow,
  resolveMinGapMinutes,
  resolvePreferredHours,
  todayYmd,
} from "./schedulePolicy.js";

/** Vietnam local date — IANA timezone (not Windows default) */
function todayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function storedUtcMs(value) {
  const raw = String(value || "").trim();
  if (!raw) return NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(" ", "T")}Z`
    : raw;
  return new Date(normalized).getTime();
}

function parseJson(s, fallback) {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}

/** Shared default media/caption folders under data/ */
export function defaultMediaPaths() {
  const root = path.resolve(path.dirname(config.databasePath));
  return {
    media_folder: path.join(root, "media", "inbox"),
    posted_folder: path.join(root, "media", "posted"),
    captions_folder: path.join(root, "media", "captions"),
  };
}

export function getDefaultConfig(pageRowId) {
  const paths = defaultMediaPaths();
  return {
    page_row_id: pageRowId,
    enabled: 0,
    max_posts_per_day: 3,
    interval_minutes: 120,
    sequence: ["photo", "video", "text"],
    media_folder: paths.media_folder,
    posted_folder: paths.posted_folder,
    captions_folder: paths.captions_folder,
    captions: [],
    pick_mode: "random",
    comment_enabled: 0,
    comment_templates: [],
    link_lists: { see_more: [], full_album: [], story_link_mode: "combo" },
    story_enabled: 0,
    story_link_mode: "combo",
    next_slot_index: 0,
    caption_slot_index: 0,
    last_post_at: null,
    posts_today: 0,
    posts_today_date: null,
  };
}

/**
 * Caption từ kho: bật/tắt.
 * - opts.use_caption = false → tắt (ưu tiên job/bulk)
 * - cfg.use_caption / link_lists.use_caption = false → tắt theo page
 * - mặc định: bật (giữ hành vi cũ)
 */
export function wantsCaption(cfg = {}, opts = {}) {
  const parse = (v) => {
    if (v === false || v === 0 || v === "0") return false;
    if (v === true || v === 1 || v === "1") return true;
    const s = String(v ?? "").trim().toLowerCase();
    if (["off", "no", "false", "tat", "tắt", "none"].includes(s)) return false;
    if (["on", "yes", "true", "bat", "bật"].includes(s)) return true;
    return null;
  };
  const fromOpts = parse(opts?.use_caption);
  if (fromOpts != null) return fromOpts;
  const ll = cfg?.link_lists && typeof cfg.link_lists === "object" ? cfg.link_lists : {};
  const fromCfg = parse(cfg?.use_caption ?? ll.use_caption ?? ll.caption_enabled);
  if (fromCfg != null) return fromCfg;
  return true;
}

export function assertCaptionIfEnabled(cfg, opts, caption, postType) {
  if (!wantsCaption(cfg, opts)) return;
  const kind = String(postType || "").toLowerCase();
  if (!["text", "photo", "image", "video"].includes(kind)) return;
  if (String(caption || "").trim()) return;
  const err = new Error(
    "Kiểm tra cấu hình: đang bật «Dùng caption» nhưng bài này không có caption. Chưa gửi Facebook."
  );
  err.code = "CAPTION_REQUIRED";
  throw err;
}

export function composePlannedComment({ cfg, opts, pageRowId, mediaPath }) {
  const want =
    opts?.comment_on === true ? true : opts?.comment_on === false ? false : !!cfg?.comment_enabled;
  const lists0 = cfg?.link_lists || {};
  if (!want || opts?.comment_skip) {
    return { enabled: !!want, skipped: !!opts?.comment_skip, text: null, link_lists: lists0 };
  }
  const assigned = assignCommentForPost({
    ...cfg,
    comment_style: opts?.match_bundle ? "bundle" : "classic",
    link_lists: opts?.match_bundle
      ? { ...(cfg.link_lists || {}), comment_link_mode: "match_media" }
      : cfg.link_lists,
    page_row_id: pageRowId,
    media_path: mediaPath || null,
    media_name: mediaPath ? path.basename(String(mediaPath)) : null,
    post_round: opts?.post_round || opts?.postRound || 1,
    pick_mode: cfg.pick_mode,
    comment_site_tracker: opts?.comment_site_tracker || null,
  });
  const lists = assigned.link_lists || cfg.link_lists || lists0;
  let text = opts?.match_bundle
    ? assigned.text
    : ensureCommentHasLink(assigned.text, lists, { force: true });
  if (text) text = applyMentionsToText(text, { ...cfg, link_lists: lists }, "comment");
  const pool = mediaLibrary.getCommentLinkPool(lists || {});
  if (pool.length && !/https?:\/\//i.test(String(text || ""))) {
    const err = new Error(
      "Kiểm tra cấu hình: bật comment kèm link nhưng không ghép được link. Chưa gửi Facebook."
    );
    err.code = "COMMENT_LINK_REQUIRED";
    throw err;
  }
  return { enabled: true, skipped: false, text: text || null, link_lists: lists };
}

export function getPagePostConfig(pageRowId) {
  const db = getDb();
  const paths = defaultMediaPaths();
  const row = db
    .prepare(`SELECT * FROM page_post_config WHERE page_row_id = ?`)
    .get(pageRowId);
  if (!row) return getDefaultConfig(pageRowId);
  const link_lists = parseJson(row.link_lists_json, { see_more: [], full_album: [] });
  const useCapRaw = link_lists?.use_caption ?? link_lists?.caption_enabled;
  const use_caption =
    useCapRaw === false || useCapRaw === 0 || useCapRaw === "0" || useCapRaw === "off"
      ? false
      : true;
  return {
    page_row_id: row.page_row_id,
    enabled: row.enabled,
    max_posts_per_day: row.max_posts_per_day,
    interval_minutes: row.interval_minutes,
    sequence: parseJson(row.sequence_json, ["photo", "video", "text"]),
    media_folder: row.media_folder || paths.media_folder,
    posted_folder: row.posted_folder || paths.posted_folder,
    captions_folder: row.captions_folder || paths.captions_folder,
    captions: parseJson(row.captions_json, []),
    pick_mode: row.pick_mode || "random",
    comment_enabled: row.comment_enabled,
    comment_templates: parseJson(row.comment_templates_json, []),
    link_lists,
    use_caption,
    story_enabled: row.story_enabled || 0,
    story_link_mode: link_lists?.story_link_mode || "combo",
    next_slot_index: row.next_slot_index || 0,
    caption_slot_index: row.caption_slot_index || 0,
    last_post_at: row.last_post_at,
    posts_today: row.posts_today || 0,
    posts_today_date: row.posts_today_date,
  };
}

export function savePagePostConfig(pageRowId, body) {
  const cur = getPagePostConfig(pageRowId);
  let next = {
    ...cur,
    ...body,
    page_row_id: pageRowId,
  };
  // Apply anti-spam floors/caps so UI and DB stay consistent
  next = clampPageLimits(next);
  // Deep-merge link_lists so bulk partial update không xóa comment_links / lead…
  const prevLl =
    cur.link_lists && typeof cur.link_lists === "object" ? cur.link_lists : {};
  const bodyLl =
    body?.link_lists && typeof body.link_lists === "object" ? body.link_lists : {};
  const linkLists = { ...prevLl, ...bodyLl };
  // Không ghi đè mảng URL đang có bằng mảng rỗng (tránh mất link khi lưu form / đổi mode)
  for (const key of [
    "comment_links",
    "full_album",
    "see_more",
    "caption_lead_links",
    "caption_lead_templates",
  ]) {
    const hasKey = Object.prototype.hasOwnProperty.call(bodyLl, key);
    if (!hasKey) continue;
    const incoming = bodyLl[key];
    const prev = prevLl[key];
    const incomingEmpty =
      incoming == null ||
      (Array.isArray(incoming) && incoming.length === 0) ||
      (typeof incoming === "string" && !String(incoming).trim());
    const prevHas =
      (Array.isArray(prev) && prev.length > 0) ||
      (typeof prev === "string" && String(prev).trim());
    if (
      incomingEmpty &&
      prevHas &&
      bodyLl.force_clear_link_lists !== true &&
      bodyLl.force_clear_link_lists !== 1
    ) {
      linkLists[key] = prev;
    }
  }
  delete linkLists.force_clear_link_lists;
  // Bỏ key undefined (từ collect partial)
  for (const k of Object.keys(linkLists)) {
    if (linkLists[k] === undefined) delete linkLists[k];
  }
  if (next.story_link_mode) {
    linkLists.story_link_mode = String(next.story_link_mode);
  }
  // Caption on/off (ảnh/video). Lưu trong link_lists để không cần migrate cột.
  if (Object.prototype.hasOwnProperty.call(body || {}, "use_caption")) {
    linkLists.use_caption = !!body.use_caption;
  } else if (Object.prototype.hasOwnProperty.call(bodyLl, "use_caption")) {
    linkLists.use_caption = !!bodyLl.use_caption;
  }
  // Gắn thẻ @[ID] — lưu trong link_lists
  if (Object.prototype.hasOwnProperty.call(body || {}, "mention_enabled")) {
    linkLists.mention_enabled = !!body.mention_enabled;
  } else if (Object.prototype.hasOwnProperty.call(bodyLl, "mention_enabled")) {
    linkLists.mention_enabled = !!bodyLl.mention_enabled;
  }
  if (Object.prototype.hasOwnProperty.call(body || {}, "mention_ids")) {
    linkLists.mention_ids = String(body.mention_ids || "");
  } else if (Object.prototype.hasOwnProperty.call(bodyLl, "mention_ids")) {
    linkLists.mention_ids = String(bodyLl.mention_ids || "");
  }
  if (Object.prototype.hasOwnProperty.call(body || {}, "mention_target")) {
    linkLists.mention_target = String(body.mention_target || "both");
  } else if (Object.prototype.hasOwnProperty.call(bodyLl, "mention_target")) {
    linkLists.mention_target = String(bodyLl.mention_target || "both");
  }
  if (Object.prototype.hasOwnProperty.call(body || {}, "mention_position")) {
    linkLists.mention_position = String(body.mention_position || "prefix");
  } else if (Object.prototype.hasOwnProperty.call(bodyLl, "mention_position")) {
    linkLists.mention_position = String(bodyLl.mention_position || "prefix");
  }
  next.link_lists = linkLists;
  next.use_caption = linkLists.use_caption !== false;
  next.story_link_mode = linkLists.story_link_mode || "combo";

  const db = getDb();
  db.prepare(
    `INSERT INTO page_post_config (
      page_row_id, enabled, max_posts_per_day, interval_minutes,
      sequence_json, media_folder, posted_folder, captions_folder, captions_json, pick_mode,
      comment_enabled, comment_templates_json, link_lists_json, story_enabled,
      next_slot_index, caption_slot_index, last_post_at, posts_today, posts_today_date, updated_at
    ) VALUES (
      @page_row_id, @enabled, @max_posts_per_day, @interval_minutes,
      @sequence_json, @media_folder, @posted_folder, @captions_folder, @captions_json, @pick_mode,
      @comment_enabled, @comment_templates_json, @link_lists_json, @story_enabled,
      @next_slot_index, @caption_slot_index, @last_post_at, @posts_today, @posts_today_date, datetime('now')
    )
    ON CONFLICT(page_row_id) DO UPDATE SET
      enabled = excluded.enabled,
      max_posts_per_day = excluded.max_posts_per_day,
      interval_minutes = excluded.interval_minutes,
      sequence_json = excluded.sequence_json,
      media_folder = excluded.media_folder,
      posted_folder = excluded.posted_folder,
      captions_folder = excluded.captions_folder,
      captions_json = excluded.captions_json,
      pick_mode = excluded.pick_mode,
      comment_enabled = excluded.comment_enabled,
      comment_templates_json = excluded.comment_templates_json,
      link_lists_json = excluded.link_lists_json,
      story_enabled = excluded.story_enabled,
      next_slot_index = excluded.next_slot_index,
      caption_slot_index = excluded.caption_slot_index,
      last_post_at = excluded.last_post_at,
      posts_today = excluded.posts_today,
      posts_today_date = excluded.posts_today_date,
      updated_at = datetime('now')`
  ).run({
    page_row_id: pageRowId,
    enabled: next.enabled ? 1 : 0,
    max_posts_per_day: Number(next.max_posts_per_day) || 3,
    interval_minutes: Number(next.interval_minutes) || 120,
    sequence_json: JSON.stringify(next.sequence || ["photo", "video", "text"]),
    media_folder: next.media_folder || "",
    posted_folder: next.posted_folder || "",
    captions_folder: next.captions_folder || "",
    captions_json: JSON.stringify(next.captions || []),
    pick_mode: (() => {
      const m = String(next.pick_mode || "").toLowerCase();
      if (m === "match_media" || m === "match_ordinal" || m === "by_media") return "match_media";
      if (m === "sequential") return "sequential";
      if (m === "random") return "random";
      return "random";
    })(),
    comment_enabled: next.comment_enabled ? 1 : 0,
    comment_templates_json: JSON.stringify(next.comment_templates || []),
    link_lists_json: JSON.stringify(next.link_lists || {}),
    story_enabled: next.story_enabled ? 1 : 0,
    next_slot_index: Number(next.next_slot_index) || 0,
    caption_slot_index: Number(next.caption_slot_index) || 0,
    last_post_at: next.last_post_at || null,
    posts_today: Number(next.posts_today) || 0,
    posts_today_date: next.posts_today_date || null,
  });
  return getPagePostConfig(pageRowId);
}

function sameMediaFolder(a, b) {
  const x = String(a || "").trim();
  const y = String(b || "").trim();
  if (!x || !y) return false;
  try {
    return path.resolve(x).toLowerCase() === path.resolve(y).toLowerCase();
  } catch {
    return x.toLowerCase() === y.toLowerCase();
  }
}

function textLines(value) {
  if (Array.isArray(value)) return value.map((s) => String(s ?? "").trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    return value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function linesExceptOrdinal(lines, ordinal) {
  return lines.filter((line) => linkLineOrdinal(line) !== ordinal);
}

/**
 * Facebook đã nhận bài Theo bộ. Chuyển caption, comment, link cùng số sang đã đăng
 * và gỡ số đó khỏi kho link của mọi page dùng cùng folder media.
 * Lỗi kho không làm hỏng bài đã đăng.
 */
export function archiveConsumedBundle({ cfg = {}, mediaPath = "", ordinal = null } = {}) {
  const n = ordinal != null ? Number(ordinal) : mediaLibrary.extractOrdinalFromName(mediaPath || "");
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: "no_ordinal" };
  const ll = cfg.link_lists && typeof cfg.link_lists === "object" ? cfg.link_lists : {};
  const linkFolder = bundleLinkFolder(cfg.media_folder);
  let fileReport = { captionLines: 0, commentLines: 0, linkLines: 0, removedLinkLines: [] };
  try {
    fileReport = archiveBundleInbox({
      ordinal: n,
      captionsFolder: cfg.captions_folder,
      commentFolder: ll.comment_open_folder || cfg.comment_open_folder,
      linkFolder,
    });
  } catch (e) {
    console.warn("[bundle-archive] file", e.message || e);
  }
  const dbLinkLines = [];
  try {
    const rows = getDb().prepare(`SELECT page_row_id, media_folder FROM page_post_config`).all();
    for (const row of rows) {
      if (!sameMediaFolder(row.media_folder, cfg.media_folder)) continue;
      const pageCfg = getPagePostConfig(row.page_row_id);
      const pageLl = pageCfg.link_lists && typeof pageCfg.link_lists === "object" ? pageCfg.link_lists : {};
      const links = textLines(pageLl.comment_links);
      const captions = textLines(pageCfg.captions);
      const templates = textLines(pageCfg.comment_templates);
      const nextLinks = linesExceptOrdinal(links, n);
      const nextCaptions = linesExceptOrdinal(captions, n);
      const nextTemplates = linesExceptOrdinal(templates, n);
      for (const line of links) {
        if (linkLineOrdinal(line) === n) dbLinkLines.push(line);
      }
      const body = {};
      if (nextLinks.length !== links.length) {
        body.link_lists = { comment_links: nextLinks };
        if (!nextLinks.length) body.link_lists.force_clear_link_lists = true;
      }
      if (nextCaptions.length !== captions.length) body.captions = nextCaptions;
      if (nextTemplates.length !== templates.length) body.comment_templates = nextTemplates;
      if (Object.keys(body).length) savePagePostConfig(row.page_row_id, body);
    }
    rememberArchivedLinkLines(linkFolder, dbLinkLines);
    const ws = getAppSetting("posting_workspace_v1", {});
    const bundle = ws?.bundle && typeof ws.bundle === "object" ? ws.bundle : null;
    if (bundle && typeof bundle.bundleCommentLinks === "string") {
      const nl = bundle.bundleCommentLinks.includes("\r\n") ? "\r\n" : "\n";
      const kept = bundle.bundleCommentLinks.split(/\r?\n/).filter((line) => linkLineOrdinal(line) !== n);
      const next = kept.join(nl);
      if (next !== bundle.bundleCommentLinks) {
        saveAppSetting("posting_workspace_v1", {
          ...ws,
          bundle: { ...bundle, bundleCommentLinks: next },
        });
      }
    }
  } catch (e) {
    console.warn("[bundle-archive] db", e.message || e);
  }
  console.log(
    `[bundle-archive] số ${n} · caption ${fileReport.captionLines || 0} · comment ${fileReport.commentLines || 0} · link ${fileReport.linkLines || 0}`
  );
  return { ok: true, ordinal: n, ...fileReport };
}

/** once: chuyển ngay. all_pages: ghi số, đợi flush cuối job. Không có post id thì không đụng kho. */
export function noteBundlePosted(opts, cfg, mediaPath, postId) {
  if (!opts?.match_bundle || !postId) return;
  const ordinal = mediaLibrary.extractOrdinalFromName(mediaPath || "");
  if (ordinal == null) return;
  if (!shouldArchiveBundleNow({ matchBundle: true, keepInInbox: opts.media_reuse === "all_pages", postId })) {
    noteSharedBundleOrdinal(opts.shared_media, ordinal);
    return;
  }
  if (mediaPath && fs.existsSync(mediaPath)) return;
  try {
    archiveConsumedBundle({ cfg, mediaPath, ordinal });
  } catch (e) {
    console.warn("[bundle-archive]", e.message || e);
  }
}

function resetDayCounterIfNeeded(cfg) {
  const today = todayYmd(420);
  if (cfg.posts_today_date !== today) {
    return { ...cfg, posts_today: 0, posts_today_date: today };
  }
  return cfg;
}

/**
 * True if page already has a direct/scheduled post within ±gap of targetMs.
 * Matches anti-spam cooldown semantics so Direct Local ↔ FB schedule don't clash.
 */
function hasNearbyEffectivePost(pageRowId, targetMs, gapMinutes) {
  const gapSec = Math.max(0, Math.floor(Number(gapMinutes) || 0) * 60);
  if (!gapSec) return false;
  try {
    const row = getDb()
      .prepare(
        `SELECT id FROM post_logs
         WHERE page_row_id = ?
           AND status IN ('ok','ok_comment_failed','scheduled','published','schedule_overdue')
           AND ABS(
             strftime('%s', COALESCE(NULLIF(scheduled_publish_time, ''), created_at))
             - ?
           ) < ?
         LIMIT 1`
      )
      .get(pageRowId, Math.floor(targetMs / 1000), gapSec);
    return !!row;
  } catch {
    return false;
  }
}

function logPost(row) {
  const db = getDb();
  // direct = đăng trực tiếp (scheduler/tay); scheduled_direct = hẹn giờ đăng trực tiếp (rotation run-now)
  const rowWithMode = {
    ...row,
    delivery_mode:
      row.delivery_mode === "scheduled_direct" ? "scheduled_direct" : "direct",
  };
  const info = db
    .prepare(
      `INSERT INTO post_logs (
        page_row_id, page_id, page_name, post_type, media_path, caption,
        fb_post_id, fb_post_url, day_index, status, error, comment_text, comment_id,
        delivery_mode, comment_due_at
      ) VALUES (
        @page_row_id, @page_id, @page_name, @post_type, @media_path, @caption,
        @fb_post_id, @fb_post_url, @day_index, @status, @error, @comment_text, @comment_id,
        @delivery_mode, @comment_due_at
      )`
    )
    .run({ ...rowWithMode, comment_due_at: rowWithMode.comment_due_at || null });
  const logRow = { id: info.lastInsertRowid, ...rowWithMode, created_at: new Date().toISOString() };
  try {
    appendPostCsv(logRow);
  } catch (e) {
    console.warn("[post csv]", e.message);
  }
  return logRow;
}

/**
 * Run one feed post for page_row_id (manual or scheduler).
 * @param {object} opts { force?: boolean } — force ignores enabled flag for manual test
 */
async function runOnePostUnlocked(pageRowId, opts = {}) {
  ensureAntiSpamTables();
  assertLicenseActive();
  // scheduled_direct = hẹn giờ đăng trực tiếp (rotation run-now chờ đúng giờ rồi đăng);
  // direct = đăng ngay (scheduler tick / đăng tay).
  const deliveryMode =
    opts.delivery_mode === "scheduled_direct" ? "scheduled_direct" : "direct";
  const db = getDb();
  const page = db
    .prepare(
      `SELECT id, page_id, name, page_token_enc, status FROM fb_pages WHERE id = ?`
    )
    .get(pageRowId);
  if (!page || page.status !== "active") {
    throw new Error("Page not found or inactive");
  }

  let cfg = clampPageLimits(resetDayCounterIfNeeded(getPagePostConfig(pageRowId)));
  if (opts.media_folder) cfg = { ...cfg, media_folder: opts.media_folder };
  if (opts.posted_folder) cfg = { ...cfg, posted_folder: opts.posted_folder };
  if (opts.captions_folder) cfg = { ...cfg, captions_folder: opts.captions_folder };
  if (!opts.force && !cfg.enabled) {
    throw new Error("Posting disabled for this page (bật enabled trong config)");
  }

  // Quota: counter + post_logs (direct + FB scheduled) so both modes share one daily cap
  if (!opts.ignore_quota) {
    const day = todayYmd(420);
    const usedLogs = countPagePostsOnLocalDay(pageRowId, day, 420);
    const used = Math.max(Number(cfg.posts_today) || 0, usedLogs);
    if (used >= cfg.max_posts_per_day) {
      throw new Error(
        `Đã đủ quota hôm nay (${used}/${cfg.max_posts_per_day}) — gồm đăng trực tiếp + hẹn FB.`
      );
    }
  }

  if (!opts.ignore_interval) {
    const anti = getAntiSpamSettings();
    const minGapMin = resolveMinGapMinutes(cfg, anti);
    const nowMs = Date.now();
    // 1) classic last_post_at (direct only)
    if (cfg.last_post_at && minGapMin > 0) {
      const last = storedUtcMs(cfg.last_post_at);
      if (Number.isFinite(last) && last <= nowMs && nowMs - last < minGapMin * 60 * 1000) {
        const left = Math.ceil((minGapMin * 60 * 1000 - (nowMs - last)) / 60000);
        throw new Error(
          `Chưa đủ interval (≥${minGapMin}p) — còn ~${left} phút`
        );
      }
    }
    // 2) any direct OR FB-scheduled slot near now (shared gap with bulk schedule)
    if (minGapMin > 0 && hasNearbyEffectivePost(pageRowId, nowMs, minGapMin)) {
      throw new Error(
        `Gần slot đã đăng/hẹn FB (gap ≥${minGapMin}p — cùng policy hẹn giờ). Đợi hoặc nới interval/anti cooldown.`
      );
    }
  }

  // Local auto-scheduler only: respect preferred hours (same as bulk “giờ tích cực”)
  if (opts.respectPreferredHours && !opts.force) {
    const pref = resolvePreferredHours(pageRowId);
    const win = isWithinPreferredWindow({
      hours: pref.hours,
      tzOffsetMinutes: 420,
      graceBeforeMin: 5,
      graceAfterMin: 55,
    });
    if (!win.ok) {
      throw new Error(
        `Ngoài giờ ưa thích [${pref.hours.join(",")}] — chờ khung giờ (khớp hẹn FB active_times)`
      );
    }
  }

  const sequence = Array.isArray(cfg.sequence) && cfg.sequence.length
    ? cfg.sequence
    : ["photo", "text"];
  const slot = cfg.next_slot_index || 0;
  const captionSlot = cfg.caption_slot_index || 0;
  const postType = String(
    opts.post_type || opts.force_type || sequence[slot % sequence.length]
  ).toLowerCase();

  const pageToken = decryptToken(page.page_token_enc);
  const captionOn = wantsCaption(cfg, opts);
  // Try several captions if duplicate blocked (exclude already-tried)
  let caption = "";
  let mediaPath = null;
  let mediaSkipped = 0;
  const triedCaptions = [];
  let selectedCaptionSlot = captionSlot;
  if (!captionOn && (postType === "photo" || postType === "image" || postType === "video")) {
    // Bỏ caption: chỉ lấy media, message có thể trống (lead link vẫn chạy nếu bật)
    const kind = postType === "video" ? "video" : "photo";
    const picked = pickUnusedMedia(
      cfg.media_folder,
      kind,
      opts.match_bundle ? "match_media" : "random_spaced",
      slot,
      cfg.posted_folder,
      {
        reuseAllPages: opts.media_reuse === "all_pages",
        reuseBag: opts.shared_media,
        reuseKey: kind,
        postRound: opts.post_round || opts.postRound || 1,
        postedFolder: cfg.posted_folder,
      }
    );
    if (picked?.error) throw new Error(picked.error);
    mediaPath = picked.path;
    mediaSkipped += picked.skipped || 0;
    const gate = assertCanPublish({
      pageRowId,
      pageId: page.page_id,
      caption: "",
      mediaPath,
      ignore_quota: !!opts.ignore_quota,
      ignore_interval: !!opts.ignore_interval,
      burst: !!opts.burst,
      reuse_all_pages: opts.media_reuse === "all_pages",
      skip_time_caps: !!opts.match_bundle,
      skip_caption_dup: !!opts.match_bundle,
    });
    if (!gate.ok) {
      releaseInflightMedia(mediaPath);
      throw new Error(gate.error || "Không đăng được (anti-spam / quota)");
    }
  } else {
    const captionPoolTotal = getCaptionStats(cfg).total;
    const maxCaptionAttempts = Math.max(1, captionPoolTotal || 1);
    // Reserve caption slot ONCE before loop — retries use slot offset so DB
    // counter is not burned on every attempt (Bug #2 fix).
    const baseReservation = reserveCaptionSlot({
      captionsFolder: cfg.captions_folder,
      captions: cfg.captions,
      pageRowId,
    });
    selectedCaptionSlot = baseReservation.slot_index;
    const captionMode = captionModeForRun(cfg, opts);
    for (let attempt = 0; attempt < maxCaptionAttempts; attempt++) {
      // Chọn media trước (match_media cần tên file để khớp số caption)
      if (
        (postType === "photo" || postType === "image" || postType === "video") &&
        !mediaPath
      ) {
        const kind = postType === "video" ? "video" : "photo";
        const picked = pickUnusedMedia(
          cfg.media_folder,
          kind,
          opts.match_bundle ? "match_media" : "random_spaced",
          slot + attempt,
          cfg.posted_folder,
          {
            reuseAllPages: opts.media_reuse === "all_pages",
            reuseBag: opts.shared_media,
            reuseKey: kind,
            postRound: opts.post_round || opts.postRound || 1,
            postedFolder: cfg.posted_folder,
          }
        );
        if (picked?.error) throw new Error(picked.error);
        mediaPath = picked.path;
        mediaSkipped += picked.skipped || 0;
      }
      caption = pickCaption(
        cfg.captions,
        selectedCaptionSlot + attempt,
        captionMode,
        cfg.captions_folder,
        triedCaptions,
        mediaPath || ""
      );
      if (caption) triedCaptions.push(caption);
      const gate = assertCanPublish({
        pageRowId,
        pageId: page.page_id,
        caption,
        mediaPath,
        ignore_quota: !!opts.ignore_quota,
        ignore_interval: !!opts.ignore_interval,
        burst: !!opts.burst,
        reuse_all_pages: opts.media_reuse === "all_pages",
      skip_time_caps: !!opts.match_bundle,
      skip_caption_dup: !!opts.match_bundle,
      });
      if (gate.ok && caption) break;
      if (gate.ok && !caption) {
        const gap = mediaLibrary.bundleCaptionGapMessage(!!opts.match_bundle, mediaPath || "");
        if (gap) {
          releaseInflightMedia(mediaPath);
          throw new Error(gap);
        }
        break;
      }
      // hard fail codes that won't fix by retrying caption/media
      if (
        [
          "IGNORE_QUOTA_LOCKED",
          "IGNORE_INTERVAL_LOCKED",
          "GRAPH_BACKOFF",
          "APP_USAGE_HIGH",
          "PAGE_BLOCKED",
          "GLOBAL_HOUR_CAP",
          "GLOBAL_DAY_CAP",
          "PAGE_COOLDOWN",
        ].includes(gate.code)
      ) {
        releaseInflightMedia(mediaPath);
        throw new Error(gate.error);
      }
      // MEDIA_DUP → bỏ media, chọn file khác rồi khớp caption lại
      if (gate.code === "MEDIA_DUP" || gate.code === "MEDIA_RECENT") {
        releaseInflightMedia(mediaPath);
        mediaPath = null;
        continue;
      }
      // match_media + CAPTION_DUP: không đổi media. Chỉ bỏ caption khi cấu hình tắt «Dùng caption».
      if (captionMode === "match_media" && gate.code === "CAPTION_DUP" && !wantsCaption(cfg, opts)) {
        caption = "";
        break;
      }
      if (!caption || attempt === maxCaptionAttempts - 1) {
        releaseInflightMedia(mediaPath);
        if (
          !wantsCaption(cfg, opts) &&
          (postType === "photo" || postType === "image" || postType === "video") &&
          (gate.code === "CAPTION_DUP" || !caption)
        ) {
          caption = "";
          break;
        }
        if (gate.code === "CAPTION_DUP" || triedCaptions.length) {
          throw new Error(
            `Hết caption khả dụng trong kho (đã dùng / trùng trong cửa sổ anti-spam). ` +
              `Đã thử ${triedCaptions.length}/${captionPoolTotal || 0} caption. Thêm dòng vào kho Caption (.txt/.csv) hoặc tắt «Dùng caption».` +
              (gate.error ? ` — ${gate.error}` : "")
          );
        }
        throw new Error(gate.error || "Không chọn được caption");
      }
      // CAPTION_DUP / MEDIA_DUP / KEYWORD → retry pick
      releaseInflightMedia(mediaPath);
      mediaPath = null;
    }
  }

  // Dòng mở đầu (view full album : + link) + caption kho — tuỳ chọn
  // Truyền media_path để mode match_media khớp số thứ tự tên file ↔ link
  if (opts.match_bundle && postType !== "text") {
    try {
      mediaLibrary.assertMatchedBundle({ mediaPath, caption, cfg });
    } catch (e) {
      releaseInflightMedia(mediaPath);
      throw e;
    }
  }
  const leadPack = opts.match_bundle
    ? { text: caption, link_lists: null }
    : composeCaptionWithLead(caption, {
    ...cfg,
    media_path: mediaPath || null,
    media_name: mediaPath ? path.basename(String(mediaPath)) : null,
  });
  caption = leadPack.text || caption;
  if (leadPack.link_lists) {
    cfg = { ...cfg, link_lists: leadPack.link_lists };
  }
  // Gắn thẻ @[PageID]/[PSID] — đầu caption (hoặc {tag} trong chữ)
  caption = applyMentionsToText(caption, cfg, "caption");

  const dayIndex = (cfg.posts_today || 0) + 1;
  let movedPath = null;
  let result = null;

  let plannedComment = null;
  try {
    assertCaptionIfEnabled(cfg, opts, caption, postType);
    plannedComment = composePlannedComment({ cfg, opts, pageRowId, mediaPath });
    if (postType === "text") {
      if (!caption) {
        throw new Error(
          "Loại text cần caption trong kho (file .txt/.csv) hoặc danh sách inline — không bịa nội dung. Bật «Dùng caption» hoặc đổi loại bài."
        );
      }
      {
        const posted = await publishFeedUnlessLinkSpam(
          (text) => publishText(page.page_id, pageToken, text),
          caption
        );
        result = posted.result;
        caption = posted.caption;
        result.link_held_for_comment = posted.heldUrls;
      }
    } else if (postType === "photo" || postType === "image") {
      if (!mediaPath) {
        throw new Error(
          `Không có ảnh chưa dùng trong media_folder: ${cfg.media_folder || "(chưa cài)"}` +
            (mediaSkipped ? ` (đã bỏ ${mediaSkipped} file trùng hash)` : "")
        );
      }
      // final hash gate
      const gate2 = assertCanPublish({
        pageRowId,
        pageId: page.page_id,
        caption,
        mediaPath,
        ignore_quota: !!opts.ignore_quota,
        ignore_interval: !!opts.ignore_interval,
        reuse_all_pages: opts.media_reuse === "all_pages",
      skip_time_caps: !!opts.match_bundle,
      skip_caption_dup: !!opts.match_bundle,
      });
      if (!gate2.ok) throw new Error(gate2.error);
      {
        const posted = await publishFeedUnlessLinkSpam(
          (text) => publishPhoto(page.page_id, pageToken, mediaPath, text),
          caption
        );
        result = posted.result;
        caption = posted.caption;
        result.link_held_for_comment = posted.heldUrls;
      }
    } else if (postType === "video") {
      if (!mediaPath) {
        throw new Error(
          `Không có video chưa dùng: ${cfg.media_folder || "(chưa cài)"}` +
            (mediaSkipped ? ` (đã bỏ ${mediaSkipped} file trùng hash)` : "")
        );
      }
      const gate2 = assertCanPublish({
        pageRowId,
        pageId: page.page_id,
        caption,
        mediaPath,
        ignore_quota: !!opts.ignore_quota,
        ignore_interval: !!opts.ignore_interval,
        reuse_all_pages: opts.media_reuse === "all_pages",
      skip_time_caps: !!opts.match_bundle,
      skip_caption_dup: !!opts.match_bundle,
      });
      if (!gate2.ok) throw new Error(gate2.error);
      // Title Meta tùy chọn: tick kho title → xoay vòng; hết thì xáo random lại
      const titlePick = pickNextVideoTitle(cfg);
      if (titlePick.warning) {
        console.warn("[video title]", titlePick.warning);
      }
      {
        const posted = await publishFeedUnlessLinkSpam(
          (text) =>
            publishVideo(page.page_id, pageToken, mediaPath, text, null, {
              title: titlePick.title || null,
            }),
          caption
        );
        result = posted.result;
        caption = posted.caption;
        result.link_held_for_comment = posted.heldUrls;
      }
      if (titlePick.title) {
        result = { ...result, video_title: titlePick.title };
      }
    } else if (
      postType === "story" ||
      postType === "story_photo" ||
      postType === "story_video" ||
      postType === "story_link"
    ) {
      // Story requires story_enabled (or force_type). Link is never a real sticker —
      // we use combo (Story + Feed link) / overlay (burn URL on image).
      if (!cfg.story_enabled && !opts.force_story) {
        throw new Error(
          "Story chưa bật cho Page này — tick «Story» trong cấu hình Page rồi Lưu."
        );
      }
      if (!mediaPath) {
        throw new Error(
          `Story cần ảnh/video trong media_folder: ${cfg.media_folder || "(chưa cài)"}` +
            (mediaSkipped ? ` (đã bỏ ${mediaSkipped} file trùng hash)` : "")
        );
      }
      const gate2 = assertCanPublish({
        pageRowId,
        pageId: page.page_id,
        caption,
        mediaPath,
        ignore_quota: !!opts.ignore_quota,
        ignore_interval: !!opts.ignore_interval,
        reuse_all_pages: opts.media_reuse === "all_pages",
      skip_time_caps: !!opts.match_bundle,
      skip_caption_dup: !!opts.match_bundle,
      });
      if (!gate2.ok) throw new Error(gate2.error);

      // Pick first URL from see_more / full_album / opts.story_link / caption
      const links = cfg.link_lists || {};
      const seeMore = Array.isArray(links.see_more)
        ? links.see_more
        : String(links.see_more || "")
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
      const albums = Array.isArray(links.full_album)
        ? links.full_album
        : String(links.full_album || "")
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
      const urlFromCaption = (caption.match(/https?:\/\/[^\s]+/i) || [])[0] || "";
      const storyLink =
        String(opts.story_link || opts.link || "").trim() ||
        seeMore[0] ||
        albums[0] ||
        urlFromCaption ||
        "";

      const linkMode =
        opts.story_link_mode ||
        cfg.story_link_mode ||
        (storyLink ? "combo" : "media_only");

      const storyType =
        postType === "story_photo"
          ? "photo"
          : postType === "story_video"
            ? "video"
            : "auto";

      const storyResult = await publishPageStoryWithLink({
        pageId: page.page_id,
        pageToken,
        filePath: mediaPath,
        link: storyLink,
        caption,
        link_mode: linkMode,
        story_type: storyType,
        metaAppKey: page.meta_app_key || "app1",
      });

      result = {
        post_id: storyResult.post_id,
        post_url: storyResult.post_url,
        story: storyResult.story,
        feed: storyResult.feed,
        notes: storyResult.notes,
        link_mode: storyResult.link_mode,
        link: storyResult.link,
        raw: storyResult,
      };
      // Prefer feed post for comment target (public feed); else story id
      if (storyResult.feed?.post_id && !result.post_id) {
        result.post_id = storyResult.feed.post_id;
        result.post_url = storyResult.feed.post_url;
      }
    } else {
      throw new Error(`Unknown post type in sequence: ${postType}`);
    }

    // Move media immediately after Graph OK + record hash forever
    const fin = finalizeMediaAfterSuccess({
      mediaPath,
      postedFolder: cfg.posted_folder,
      page_row_id: pageRowId,
      page_id: page.page_id,
      fb_post_id: result?.post_id,
      caption,
      keep_in_inbox: opts.media_reuse === "all_pages",
    });
    releaseInflightMedia(mediaPath);
    movedPath = fin.movedPath;

    let commentText = plannedComment?.text || null;
    let commentId = null;
    let commentPreviewFallback = false;
    let commentPreviewNote = "";
    let commentLinkLists = plannedComment?.link_lists || cfg.link_lists;
    const wantComment = !!plannedComment?.enabled && !plannedComment?.skipped;
    const commentTiming = readCommentTiming(commentLinkLists);
    if (wantComment && result?.post_id && commentText) {
      const heldUrls = Array.isArray(result?.link_held_for_comment) ? result.link_held_for_comment : [];
      if (heldUrls.length) {
        const missing = heldUrls.filter((url) => !String(commentText || "").includes(url));
        if (missing.length) commentText = [commentText, ...missing].filter(Boolean).join("\n");
      }
      // «Sau publish» + số phút / số like: bài đã lên, comment để scheduler gửi đúng giờ.
      const deferComment =
        commentTiming.afterPublish &&
        (commentTiming.delayMin > 0 || commentTiming.minLikes > 0);
      if (deferComment && commentText) {
        const dueIso = commentDueIso(Date.now(), commentTiming.delayMin);
        const logWait = logPost({
          page_row_id: pageRowId,
          page_id: page.page_id,
          page_name: page.name,
          post_type: postType,
          media_path: movedPath || mediaPath,
          caption,
          fb_post_id: result.post_id,
          fb_post_url: result.post_url,
          day_index: dayIndex,
          status: "ok",
          error: null,
          comment_text: commentText,
          comment_id: null,
          comment_due_at: dueIso,
          delivery_mode: deliveryMode,
        });
        savePagePostConfig(pageRowId, {
          ...cfg,
          link_lists: commentLinkLists,
          next_slot_index: slot + 1,
          caption_slot_index: caption ? selectedCaptionSlot + 1 : captionSlot,
          last_post_at: new Date().toISOString().replace("T", " ").slice(0, 19),
          posts_today: dayIndex,
          posts_today_date: todayYmd(420),
        });
        noteBundlePosted(opts, cfg, mediaPath, result?.post_id);
        return {
          ok: true,
          post: result,
          comment_id: null,
          comment_text: commentText,
          comment_error: null,
          comment_pending: true,
          comment_when: "after_publish",
          comment_delay_minutes: commentTiming.delayMin,
          comment_min_likes: commentTiming.minLikes,
          comment_ready_at: dueIso,
          comment_immediate: false,
          caption_sent: !!String(caption || "").trim(),
          log: logWait,
          day_index: dayIndex,
          post_type: postType,
          media_moved_to: movedPath,
          media_hash: fin.hash,
        };
      }
      const commentGate = isPageCircuitOpen(pageRowId, "comment");
      const authGate = isPageCircuitOpen(pageRowId, "auth");
      const heldGate = commentGate.open ? commentGate : authGate;
      if (heldGate.open) {
        const skipNote = `Comment đang khóa. Còn ${heldGate.seconds_left}s. ${heldGate.reason || ""}`.trim();
        const logSkip = logPost({
          page_row_id: pageRowId,
          page_id: page.page_id,
          page_name: page.name,
          post_type: postType,
          media_path: movedPath || mediaPath,
          caption,
          fb_post_id: result.post_id,
          fb_post_url: result.post_url,
          day_index: dayIndex,
          status: "comment_skipped_banned",
          error: skipNote,
          comment_text: commentText,
          comment_id: null,
          delivery_mode: deliveryMode,
        });
        savePagePostConfig(pageRowId, {
          ...cfg,
          link_lists: commentLinkLists,
          next_slot_index: slot + 1,
          caption_slot_index: caption ? selectedCaptionSlot + 1 : captionSlot,
          last_post_at: new Date().toISOString().replace("T", " ").slice(0, 19),
          posts_today: dayIndex,
          posts_today_date: todayYmd(420),
        });
        noteBundlePosted(opts, cfg, mediaPath, result?.post_id);
        return {
          ok: true,
          post: result,
          comment_id: null,
          comment_text: commentText,
          comment_error: skipNote,
          comment_skipped_banned: true,
          caption_sent: !!String(caption || "").trim(),
          comment_when: commentTiming.when,
          log: logSkip,
          day_index: dayIndex,
          post_type: postType,
          media_moved_to: movedPath,
          media_hash: fin.hash,
        };
      }
      if (commentText) {
        let commentErr = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const c = await publishComment(result.post_id, pageToken, commentText);
            commentId = c.comment_id;
            commentPreviewFallback = !!c.preview_fallback;
            commentPreviewNote = c.attachment_error || "";
            commentErr = null;
            break;
          } catch (ce) {
            commentErr = ce;
            commentId = null;
            commentPreviewFallback = false;
            commentPreviewNote = "";
            if (isSpamBlockError(ce) || isPermissionError(ce)) {
              const code = Number(ce?.code ?? ce?.fb?.code ?? NaN);
              openPageCircuit(pageRowId, code === 190 ? "auth" : "comment", ce.message || String(ce));
              break;
            }
            const retryable =
              attempt < 2 &&
              (isCommunitySpamBlock(ce) ||
                isGraphRateLimitError(ce) ||
                /try again|thử lại|please retry|temporarily(?! blocked)/i.test(ce.message || String(ce)));
            if (!retryable) break;
            await new Promise((r) => setTimeout(r, 12000));
          }
        }
        if (commentErr) {
          const ce = commentErr;
          const retryLater =
            !isSpamBlockError(ce) &&
            !isPermissionError(ce) &&
            (isCommunitySpamBlock(ce) ||
              isGraphRateLimitError(ce) ||
              /try again|thử lại|please retry|temporarily(?! blocked)/i.test(ce.message || String(ce)));
          if (retryLater) {
            const logWaitComment = logPost({
              page_row_id: pageRowId,
              page_id: page.page_id,
              page_name: page.name,
              post_type: postType,
              media_path: movedPath || mediaPath,
              caption,
              fb_post_id: result.post_id,
              fb_post_url: result.post_url,
              day_index: dayIndex,
              status: "ok",
              error: null,
              comment_text: commentText,
              comment_id: null,
              delivery_mode: deliveryMode,
            });
            savePagePostConfig(pageRowId, {
              ...cfg,
              link_lists: commentLinkLists,
              next_slot_index: slot + 1,
              caption_slot_index: caption ? selectedCaptionSlot + 1 : captionSlot,
              last_post_at: new Date().toISOString().replace("T", " ").slice(0, 19),
              posts_today: dayIndex,
              posts_today_date: todayYmd(420),
            });
            noteBundlePosted(opts, cfg, mediaPath, result?.post_id);
            return {
              ok: true,
              post: result,
              comment_id: null,
              comment_text: commentText,
              comment_error: null,
              comment_pending: true,
              comment_when: commentTiming.when,
              caption_sent: !!String(caption || "").trim(),
              log: logWaitComment,
              day_index: dayIndex,
              post_type: postType,
              media_moved_to: movedPath,
              media_hash: fin.hash,
            };
          }
          commentText = `[comment failed] ${commentText}`;
          const logFailComment = logPost({
            page_row_id: pageRowId,
            page_id: page.page_id,
            page_name: page.name,
            post_type: postType,
            media_path: movedPath || mediaPath,
            caption,
            fb_post_id: result.post_id,
            fb_post_url: result.post_url,
            day_index: dayIndex,
            status: "ok_comment_failed",
            error: formatFbNotice(ce) || ce.message,
            comment_text: commentText,
            comment_id: null,
            delivery_mode: deliveryMode,
          });
          savePagePostConfig(pageRowId, {
            ...cfg,
            link_lists: commentLinkLists,
            next_slot_index: slot + 1,
            caption_slot_index: caption ? selectedCaptionSlot + 1 : captionSlot,
            last_post_at: new Date().toISOString().replace("T", " ").slice(0, 19),
            posts_today: dayIndex,
            posts_today_date: todayYmd(420),
          });
          noteBundlePosted(opts, cfg, mediaPath, result?.post_id);
          return {
            ok: true,
            post: result,
            comment_id: null,
            comment_text: commentText,
            comment_error: formatFbNotice(ce) || ce.message,
            comment_preview_fallback: false,
            caption_sent: !!String(caption || "").trim(),
            comment_when: commentTiming.when,
            log: logFailComment,
            day_index: dayIndex,
            post_type: postType,
            media_moved_to: movedPath,
            media_hash: fin.hash,
          };
        }
      }
    }

    const log = logPost({
      page_row_id: pageRowId,
      page_id: page.page_id,
      page_name: page.name,
      post_type: postType,
      media_path: movedPath || mediaPath,
      caption,
      fb_post_id: result.post_id,
      fb_post_url: result.post_url,
      day_index: dayIndex,
      status: "ok",
      error: commentPreviewFallback
        ? commentPreviewNote || COMMENT_PREVIEW_FALLBACK_NOTE
        : null,
      comment_text: commentText,
      comment_id: commentId,
      delivery_mode: deliveryMode,
    });

    savePagePostConfig(pageRowId, {
      ...cfg,
      link_lists: commentLinkLists,
      next_slot_index: slot + 1,
      caption_slot_index: caption ? selectedCaptionSlot + 1 : captionSlot,
      last_post_at: new Date().toISOString().replace("T", " ").slice(0, 19),
      posts_today: dayIndex,
      posts_today_date: todayYmd(420),
    });
    noteBundlePosted(opts, cfg, mediaPath, result?.post_id);

    return {
      ok: true,
      post: result,
      log,
      day_index: dayIndex,
      post_type: postType,
      media_moved_to: movedPath,
      media_hash: fin.hash,
      comment_id: commentId,
      comment_text: commentText,
      comment_error: null,
      comment_when: commentText ? commentTiming.when : null,
      comment_preview_fallback: commentPreviewFallback,
      comment_preview_note: commentPreviewNote || null,
      caption_sent: !!String(caption || "").trim(),
      comment_pending:
        !!commentText && !commentId && !String(commentText).startsWith("[comment failed]"),
      comment_immediate: !!commentId,
    };
  } catch (e) {
    // Only Graph API failures trigger backoff — not local validation (caption/media empty)
    // Primary indicator: publish.js always sets e.fb on Graph errors.
    // Numeric codes: standard FB throttle/auth codes.
    // Regex fallback: avoid generic words like "permission" (matches EACCES)
    // or bare "spam" (too broad).
    const isGraphFail =
      !!e.fb ||
      (typeof e.code === "number" &&
        [4, 17, 32, 100, 190, 200, 341].includes(e.code)) ||
      /\bgraph(?:\.facebook)?\b|\bfacebook\b.*error|\boauth\b.*token|\brate.?limit\b|\bapi[.\s]spam\b|\b#\d{2,}\b/i.test(
        String(e.message || "")
      );
    const isLocalValidation =
      /caption|media|inbox|kho|quota|interval|cooldown|anti-spam|hết caption|không có ảnh|không có video|Kiểm tra cấu hình/i.test(
        String(e.message || "")
      );
    releaseInflightMedia(mediaPath);
    if (isGraphFail && !isLocalValidation) {
      noteGraphFailure(e);
    }
    // Auto scheduler chạy mọi page bật «Auto scheduler», không theo tick.
    // Kho chỉ có video mà bước hiện tại là ảnh thì không ghi báo cáo —
    // nếu không, page không chọn bị lặp câu này mỗi phút.
    if (opts.from_scheduler && isUnusedMediaMiss(e.message)) {
      return {
        ok: false,
        skipped: true,
        error: e.message,
        post_type: postType,
        log: null,
      };
    }
    const log = logPost({
      page_row_id: pageRowId,
      page_id: page.page_id,
      page_name: page.name,
      post_type: postType,
      media_path: mediaPath,
      caption,
      fb_post_id: null,
      fb_post_url: null,
      day_index: dayIndex,
      status: "fail",
      error: e.message,
      comment_text: null,
      comment_id: null,
      delivery_mode: deliveryMode,
    });
    return {
      ok: false,
      error: e.message,
      fb: e.fb || null,
      log,
      post_type: postType,
    };
  }
}

function urlsInText(text) {
  return String(text || "").match(/https?:\/\/[^\s<>"']+/gi) || [];
}

function captionWithoutPublicUrls(text) {
  const raw = String(text || "").trim();
  if (!/https?:\/\//i.test(raw)) return raw;
  const kept = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/https?:\/\/\S+/gi, "").trim())
    .filter((line) => line && !/^(view full album|xem full album)\s*:?$/i.test(line));
  return kept.join("\n\n").trim();
}

/** Đăng trực tiếp: câu spam của Facebook thường do link trong bài, không phải page bị khóa. */
async function publishFeedUnlessLinkSpam(run, caption) {
  try {
    return { result: await run(caption), caption, heldUrls: [] };
  } catch (e) {
    const plain = captionWithoutPublicUrls(caption);
    const heldUrls = urlsInText(caption);
    if (!isCommunitySpamBlock(e) || !heldUrls.length || plain === String(caption || "").trim()) throw e;
    const result = await run(plain);
    return { result, caption: plain, heldUrls };
  }
}

export async function runOnePost(pageRowId, opts = {}) {
  return withPageOperationLock(
    pageRowId,
    () => runOnePostUnlocked(pageRowId, opts),
    { maxConcurrent: opts.burst ? 3 : 1 }
  );
}

/** Scheduler tick: process all enabled pages that are due */
export async function runSchedulerTick() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT c.page_row_id FROM page_post_config c
       JOIN fb_pages p ON p.id = c.page_row_id
       WHERE c.enabled = 1 AND p.status = 'active'`
    )
    .all();

  const results = [];
  for (const r of rows) {
    try {
      // respectPreferredHours: same preferred hours as FB bulk “giờ tích cực”
      const out = await runOnePost(r.page_row_id, {
        force: false,
        respectPreferredHours: true,
        from_scheduler: true,
      });
      results.push({ page_row_id: r.page_row_id, ...out });
    } catch (e) {
      // not due / disabled quota — skip silently or record skip
      results.push({
        page_row_id: r.page_row_id,
        ok: false,
        skipped: true,
        error: e.message,
      });
    }
  }
  return results;
}

function postKindLabel(postType) {
  const s = String(postType || "").toLowerCase();
  if (s === "video") return "video";
  if (s === "photo" || s === "image") return "ảnh";
  if (s === "text") return "text";
  if (s.startsWith("story")) return "story";
  return s || "—";
}

function captionNote(text) {
  const s = String(text || "").trim();
  if (!s) return "Chưa có caption";
  return /https?:\/\//i.test(s) ? "Có caption · có link" : "Có caption · không có link";
}

function commentNote(text, commentId) {
  const s = String(text || "").trim();
  if (!s && !commentId) return "Chưa có comment";
  const hasLink = /https?:\/\//i.test(s);
  const opener = s.replace(/https?:\/\/\S+/gi, "").trim();
  const parts = [
    opener ? "Có câu mở đầu" : "Không có câu mở đầu",
    hasLink ? "có link" : "không có link",
    commentId ? "đã gửi" : "chờ bài publish",
  ];
  return parts.join(" · ");
}

function decoratePostLog(row) {
  const scheduled = !!row.scheduled_publish_time;
  const kind = postKindLabel(row.post_type);
  return {
    ...row,
    delivery_note: scheduled ? `Đã hẹn ${kind}` : `Đã đăng ${kind}`,
    caption_note: captionNote(row.caption),
    caption_preview: String(row.caption || "").replace(/\s+/g, " ").slice(0, 140),
    comment_note: commentNote(row.comment_text, row.comment_id),
    comment_preview: String(row.comment_text || "").replace(/\s+/g, " ").slice(0, 160),
  };
}

function isUnusedMediaMiss(message) {
  return /^Không có (ảnh|video) chưa dùng/.test(String(message || ""));
}

function selectedPageIdSet() {
  try {
    const row = getDb()
      .prepare(`SELECT value_json FROM app_settings WHERE key = ?`)
      .get("posting_workspace_v1");
    const data = row?.value_json ? JSON.parse(row.value_json) : {};
    const ids = Array.isArray(data.selected_page_ids) ? data.selected_page_ids : [];
    return new Set(ids.map(Number).filter((id) => id > 0));
  } catch {
    return new Set();
  }
}

export function listPostLogs({ pageRowId, limit = 100 } = {}) {
  const db = getDb();
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  const cols = `id, page_row_id, page_id, page_name, post_type, fb_post_id, fb_post_url,
    status, substr(COALESCE(error,''),1,300) AS error, scheduled_publish_time, created_at,
    comment_id, substr(COALESCE(caption,''),1,400) AS caption,
    substr(COALESCE(comment_text,''),1,400) AS comment_text`;
  const selected = pageRowId ? null : selectedPageIdSet();
  const fetchLimit = selected && selected.size ? Math.min(5000, safeLimit * 25) : safeLimit;
  const rows = pageRowId
    ? db.prepare(`SELECT ${cols} FROM post_logs WHERE page_row_id = ? ORDER BY id DESC LIMIT ?`).all(pageRowId, safeLimit)
    : db.prepare(`SELECT ${cols} FROM post_logs ORDER BY id DESC LIMIT ?`).all(fetchLimit);
  const visible = selected && selected.size
    ? rows.filter((row) => {
        if (!isUnusedMediaMiss(row.error)) return true;
        return selected.has(Number(row.page_row_id));
      })
    : rows;
  return visible.slice(0, safeLimit).map(decoratePostLog);
}

export function mediaStats(folder) {
  return {
    photos: countUnusedMedia(folder, "photo"),
    videos: countUnusedMedia(folder, "video"),
    folder: folder || null,
  };
}

export function getCaptionStats(cfg) {
  const basic = captionPoolStats(cfg.captions_folder, cfg.captions);
  // Namespace fallback — tránh ReferenceError nếu named import bị thiếu khi build
  const loadDisk =
    typeof loadCaptionsFromDisk === "function"
      ? loadCaptionsFromDisk
      : typeof mediaLibrary.loadCaptionsFromDisk === "function"
        ? mediaLibrary.loadCaptionsFromDisk
        : () => [];
  let fromDisk = [];
  try {
    fromDisk = loadDisk(cfg?.captions_folder) || [];
  } catch (e) {
    console.warn("[getCaptionStats] load captions:", e.message);
    fromDisk = [];
  }
  const inline = Array.isArray(cfg.captions)
    ? cfg.captions.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const poolByNorm = new Map();
  for (const caption of [...fromDisk, ...inline]) {
    const norm = normalizeCaption(caption);
    if (norm && !poolByNorm.has(norm)) poolByNorm.set(norm, caption);
  }

  const total = poolByNorm.size;
  const anti = getAntiSpamSettings();
  if (!anti.enabled || !anti.block_duplicate_caption || !total) {
    return {
      ...basic,
      total,
      available: total,
      used_recent: 0,
      duplicate_window_hours: Number(anti.caption_dup_window_hours) || 0,
    };
  }

  const since = new Date(
    Date.now() - (Number(anti.caption_dup_window_hours) || 48) * 60 * 60 * 1000
  ).toISOString();
  ensureAntiSpamTables();
  const used = new Set(
    getDb()
      .prepare(`SELECT caption_norm FROM caption_recent WHERE created_at >= ?`)
      .all(since)
      .map((row) => normalizeCaption(row.caption_norm))
      .filter(Boolean)
  );
  for (const row of getDb()
    .prepare(
      `SELECT caption FROM post_logs
       WHERE status IN ('ok','ok_comment_failed','scheduled','published','schedule_overdue')
         AND created_at >= ? AND caption IS NOT NULL AND trim(caption) != ''`
    )
    .all(since)) {
    const norm = normalizeCaption(row.caption);
    if (norm) used.add(norm);
  }
  const usedRecent = [...poolByNorm.keys()].filter((norm) => used.has(norm)).length;
  return {
    ...basic,
    total,
    available: Math.max(0, total - usedRecent),
    used_recent: usedRecent,
    duplicate_window_hours: Number(anti.caption_dup_window_hours) || 48,
  };
}
