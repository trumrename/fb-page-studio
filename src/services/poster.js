/**
 * Orchestrate one feed post for a page: media + caption + optional comment + CSV/DB log.
 * Story: skipped unless story_enabled (not implemented — returns clear error if forced).
 */
import path from "path";
import { getDb } from "../db/index.js";
import { config } from "../config.js";
import { decryptToken } from "./crypto.js";
import {
  publishText,
  publishPhoto,
  publishVideo,
  publishComment,
  isImageFile,
  isVideoFile,
} from "./publish.js";
import {
  pickMedia,
  moveToPosted,
  pickCaption,
  buildComment,
  ensureDir,
  listMediaFiles,
  captionPoolStats,
  loadCaptionsFromDisk,
} from "./mediaLibrary.js";
import { appendPostCsv } from "./postLogCsv.js";
import {
  assertCanPublish,
  pickUnusedMedia,
  finalizeMediaAfterSuccess,
  noteGraphFailure,
  clampPageLimits,
  ensureAntiSpamTables,
} from "./antiSpam.js";

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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
    link_lists: { see_more: [], full_album: [] },
    story_enabled: 0,
    next_slot_index: 0,
    last_post_at: null,
    posts_today: 0,
    posts_today_date: null,
  };
}

export function getPagePostConfig(pageRowId) {
  const db = getDb();
  const paths = defaultMediaPaths();
  const row = db
    .prepare(`SELECT * FROM page_post_config WHERE page_row_id = ?`)
    .get(pageRowId);
  if (!row) return getDefaultConfig(pageRowId);
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
    link_lists: parseJson(row.link_lists_json, { see_more: [], full_album: [] }),
    story_enabled: row.story_enabled || 0,
    next_slot_index: row.next_slot_index || 0,
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
  const db = getDb();
  db.prepare(
    `INSERT INTO page_post_config (
      page_row_id, enabled, max_posts_per_day, interval_minutes,
      sequence_json, media_folder, posted_folder, captions_folder, captions_json, pick_mode,
      comment_enabled, comment_templates_json, link_lists_json, story_enabled,
      next_slot_index, last_post_at, posts_today, posts_today_date, updated_at
    ) VALUES (
      @page_row_id, @enabled, @max_posts_per_day, @interval_minutes,
      @sequence_json, @media_folder, @posted_folder, @captions_folder, @captions_json, @pick_mode,
      @comment_enabled, @comment_templates_json, @link_lists_json, @story_enabled,
      @next_slot_index, @last_post_at, @posts_today, @posts_today_date, datetime('now')
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
    pick_mode: next.pick_mode === "sequential" ? "sequential" : "random",
    comment_enabled: next.comment_enabled ? 1 : 0,
    comment_templates_json: JSON.stringify(next.comment_templates || []),
    link_lists_json: JSON.stringify(next.link_lists || {}),
    story_enabled: next.story_enabled ? 1 : 0,
    next_slot_index: Number(next.next_slot_index) || 0,
    last_post_at: next.last_post_at || null,
    posts_today: Number(next.posts_today) || 0,
    posts_today_date: next.posts_today_date || null,
  });
  return getPagePostConfig(pageRowId);
}

function resetDayCounterIfNeeded(cfg) {
  const today = todayKey();
  if (cfg.posts_today_date !== today) {
    return { ...cfg, posts_today: 0, posts_today_date: today };
  }
  return cfg;
}

function logPost(row) {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO post_logs (
        page_row_id, page_id, page_name, post_type, media_path, caption,
        fb_post_id, fb_post_url, day_index, status, error, comment_text, comment_id
      ) VALUES (
        @page_row_id, @page_id, @page_name, @post_type, @media_path, @caption,
        @fb_post_id, @fb_post_url, @day_index, @status, @error, @comment_text, @comment_id
      )`
    )
    .run(row);
  const logRow = { id: info.lastInsertRowid, ...row, created_at: new Date().toISOString() };
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
export async function runOnePost(pageRowId, opts = {}) {
  ensureAntiSpamTables();
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
  if (!opts.force && !cfg.enabled) {
    throw new Error("Posting disabled for this page (bật enabled trong config)");
  }

  if (cfg.posts_today >= cfg.max_posts_per_day && !opts.ignore_quota) {
    throw new Error(
      `Đã đủ quota hôm nay (${cfg.posts_today}/${cfg.max_posts_per_day})`
    );
  }

  if (cfg.last_post_at && !opts.ignore_interval) {
    const last = new Date(cfg.last_post_at.replace(" ", "T")).getTime();
    const waitMs = (cfg.interval_minutes || 0) * 60 * 1000;
    if (Number.isFinite(last) && Date.now() - last < waitMs) {
      const left = Math.ceil((waitMs - (Date.now() - last)) / 60000);
      throw new Error(`Chưa đủ interval — còn ~${left} phút`);
    }
  }

  const sequence = Array.isArray(cfg.sequence) && cfg.sequence.length
    ? cfg.sequence
    : ["photo", "text"];
  const slot = cfg.next_slot_index || 0;
  const postType = String(sequence[slot % sequence.length]).toLowerCase();

  const pageToken = decryptToken(page.page_token_enc);
  // Try several captions if duplicate blocked (exclude already-tried)
  let caption = "";
  let mediaPath = null;
  let mediaSkipped = 0;
  const triedCaptions = [];
  for (let attempt = 0; attempt < 12; attempt++) {
    caption = pickCaption(
      cfg.captions,
      slot + attempt,
      attempt === 0 ? cfg.pick_mode || "random" : "sequential",
      cfg.captions_folder,
      triedCaptions
    );
    if (caption) triedCaptions.push(caption);
    if (postType === "photo" || postType === "image" || postType === "video") {
      const kind = postType === "video" ? "video" : "photo";
      const picked = pickUnusedMedia(
        cfg.media_folder,
        kind,
        cfg.pick_mode,
        slot + attempt,
        cfg.posted_folder
      );
      mediaPath = picked.path;
      mediaSkipped += picked.skipped || 0;
    }
    const gate = assertCanPublish({
      pageRowId,
      pageId: page.page_id,
      caption,
      mediaPath,
      ignore_quota: !!opts.ignore_quota,
      ignore_interval: !!opts.ignore_interval,
    });
    if (gate.ok && caption) break;
    if (gate.ok && !caption) {
      // empty pool
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
      throw new Error(gate.error);
    }
    if (!caption || attempt === 11) {
      if (gate.code === "CAPTION_DUP" || triedCaptions.length) {
        throw new Error(
          `Hết caption khả dụng trong kho (đã dùng / trùng trong cửa sổ anti-spam). ` +
            `Đã thử ${triedCaptions.length} caption. Thêm dòng vào data/media/captions (.txt/.csv).` +
            (gate.error ? ` — ${gate.error}` : "")
        );
      }
      throw new Error(gate.error || "Không chọn được caption");
    }
    // CAPTION_DUP / MEDIA_DUP / KEYWORD → retry pick
    mediaPath = null;
  }

  const dayIndex = (cfg.posts_today || 0) + 1;
  let movedPath = null;
  let result = null;

  try {
    if (postType === "text") {
      if (!caption) {
        throw new Error(
          "Loại text cần caption trong kho (file .txt/.csv) hoặc danh sách inline — không bịa nội dung"
        );
      }
      result = await publishText(page.page_id, pageToken, caption);
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
      });
      if (!gate2.ok) throw new Error(gate2.error);
      result = await publishPhoto(
        page.page_id,
        pageToken,
        mediaPath,
        caption
      );
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
      });
      if (!gate2.ok) throw new Error(gate2.error);
      result = await publishVideo(
        page.page_id,
        pageToken,
        mediaPath,
        caption
      );
    } else if (postType === "story" || postType === "story_photo" || postType === "story_video") {
      throw new Error(
        "Story tạm tắt / chưa bật trong phase này (story_enabled chỉ là flag; chưa implement API story)"
      );
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
    });
    movedPath = fin.movedPath;

    let commentText = null;
    let commentId = null;
    if (cfg.comment_enabled && result?.post_id) {
      commentText = buildComment(
        cfg.comment_templates,
        cfg.link_lists,
        "random"
      );
      if (commentText) {
        try {
          const c = await publishComment(
            result.post_id,
            pageToken,
            commentText
          );
          commentId = c.comment_id;
        } catch (ce) {
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
            error: ce.message,
            comment_text: commentText,
            comment_id: null,
          });
          savePagePostConfig(pageRowId, {
            ...cfg,
            next_slot_index: slot + 1,
            last_post_at: new Date().toISOString().replace("T", " ").slice(0, 19),
            posts_today: dayIndex,
            posts_today_date: todayKey(),
          });
          return {
            ok: true,
            post: result,
            comment_error: ce.message,
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
      error: null,
      comment_text: commentText,
      comment_id: commentId,
    });

    savePagePostConfig(pageRowId, {
      ...cfg,
      next_slot_index: slot + 1,
      last_post_at: new Date().toISOString().replace("T", " ").slice(0, 19),
      posts_today: dayIndex,
      posts_today_date: todayKey(),
    });

    return {
      ok: true,
      post: result,
      log,
      day_index: dayIndex,
      post_type: postType,
      media_moved_to: movedPath,
      media_hash: fin.hash,
    };
  } catch (e) {
    // Only Graph API failures trigger backoff — not local validation (caption/media empty)
    const isGraphFail =
      !!e.fb ||
      e.code === 4 ||
      e.code === 17 ||
      /graph|facebook|oauth|rate limit|spam|permission|#\d+/i.test(
        String(e.message || "")
      );
    const isLocalValidation =
      /caption|media|inbox|kho|quota|interval|cooldown|anti-spam|hết caption|không có ảnh|không có video/i.test(
        String(e.message || "")
      );
    if (isGraphFail && !isLocalValidation) {
      noteGraphFailure(e);
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
      const out = await runOnePost(r.page_row_id, { force: false });
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

export function listPostLogs({ pageRowId, limit = 100 } = {}) {
  const db = getDb();
  if (pageRowId) {
    return db
      .prepare(
        `SELECT * FROM post_logs WHERE page_row_id = ? ORDER BY id DESC LIMIT ?`
      )
      .all(pageRowId, limit);
  }
  return db
    .prepare(`SELECT * FROM post_logs ORDER BY id DESC LIMIT ?`)
    .all(limit);
}

export function mediaStats(folder) {
  return {
    photos: listMediaFiles(folder, "photo").length,
    videos: listMediaFiles(folder, "video").length,
    folder: folder || null,
  };
}

export function getCaptionStats(cfg) {
  return captionPoolStats(cfg.captions_folder, cfg.captions);
}
