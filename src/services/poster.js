/**
 * Orchestrate one feed/story post for a page: media + caption + optional comment + CSV/DB log.
 * Story: Page Stories API (photo/video) + link strategy (combo/overlay) — no official link sticker.
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
import { publishPageStoryWithLink } from "./pageStories.js";
import {
  pickMedia,
  moveToPosted,
  pickCaption,
  composeCaptionWithLead,
  loadCaptionsFromDisk,
  buildComment,
  assignCommentForPost,
  ensureDir,
  listMediaFiles,
  captionPoolStats,
} from "./mediaLibrary.js";
import { pickNextVideoTitle } from "./videoTitlePool.js";
import { appendPostCsv } from "./postLogCsv.js";
import {
  assertCanPublish,
  pickUnusedMedia,
  finalizeMediaAfterSuccess,
  countUnusedMedia,
  noteGraphFailure,
  clampPageLimits,
  ensureAntiSpamTables,
  getAntiSpamSettings,
  normalizeCaption,
} from "./antiSpam.js";
import { assertCanPublish as assertLicenseActive } from "./license.js";
import { withPageOperationLock } from "./pageOperationLock.js";
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
    story_link_mode:
      parseJson(row.link_lists_json, {})?.story_link_mode || "combo",
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
  const linkLists = {
    ...(cur.link_lists && typeof cur.link_lists === "object" ? cur.link_lists : {}),
    ...(body?.link_lists && typeof body.link_lists === "object" ? body.link_lists : {}),
  };
  if (next.story_link_mode) {
    linkLists.story_link_mode = String(next.story_link_mode);
  }
  next.link_lists = linkLists;
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
    pick_mode: next.pick_mode === "sequential" ? "sequential" : "random",
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
        delivery_mode
      ) VALUES (
        @page_row_id, @page_id, @page_name, @post_type, @media_path, @caption,
        @fb_post_id, @fb_post_url, @day_index, @status, @error, @comment_text, @comment_id,
        @delivery_mode
      )`
    )
    .run(rowWithMode);
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
  // Try several captions if duplicate blocked (exclude already-tried)
  let caption = "";
  let mediaPath = null;
  let mediaSkipped = 0;
  const triedCaptions = [];
  const captionPoolTotal = getCaptionStats(cfg).total;
  const maxCaptionAttempts = Math.max(1, captionPoolTotal || 1);
  // Reserve caption slot ONCE before loop — retries use slot offset so DB
  // counter is not burned on every attempt (Bug #2 fix).
  const baseReservation = reserveCaptionSlot({
    captionsFolder: cfg.captions_folder,
    captions: cfg.captions,
    pageRowId,
  });
  let selectedCaptionSlot = baseReservation.slot_index;
  for (let attempt = 0; attempt < maxCaptionAttempts; attempt++) {
    caption = pickCaption(
      cfg.captions,
      selectedCaptionSlot + attempt,
      "sequential_shuffle",
      cfg.captions_folder,
      triedCaptions
    );
    if (caption) triedCaptions.push(caption);
    if (postType === "photo" || postType === "image" || postType === "video") {
      const kind = postType === "video" ? "video" : "photo";
      const picked = pickUnusedMedia(
        cfg.media_folder,
        kind,
        "random_spaced",
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
    if (!caption || attempt === maxCaptionAttempts - 1) {
      if (gate.code === "CAPTION_DUP" || triedCaptions.length) {
        throw new Error(
          `Hết caption khả dụng trong kho (đã dùng / trùng trong cửa sổ anti-spam). ` +
            `Đã thử ${triedCaptions.length}/${captionPoolTotal || 0} caption. Thêm dòng vào kho Caption (.txt/.csv).` +
            (gate.error ? ` — ${gate.error}` : "")
        );
      }
      throw new Error(gate.error || "Không chọn được caption");
    }
    // CAPTION_DUP / MEDIA_DUP / KEYWORD → retry pick
    mediaPath = null;
  }

  // Dòng mở đầu (view full album : + link) + caption kho — tuỳ chọn
  const leadPack = composeCaptionWithLead(caption, cfg);
  caption = leadPack.text || caption;
  if (leadPack.link_lists) {
    cfg = { ...cfg, link_lists: leadPack.link_lists };
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
      // Title Meta tùy chọn: tick kho title → xoay vòng; hết thì xáo random lại
      const titlePick = pickNextVideoTitle(cfg);
      if (titlePick.warning) {
        console.warn("[video title]", titlePick.warning);
      }
      result = await publishVideo(
        page.page_id,
        pageToken,
        mediaPath,
        caption,
        null,
        { title: titlePick.title || null }
      );
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
    });
    movedPath = fin.movedPath;

    let commentText = null;
    let commentId = null;
    let commentLinkLists = cfg.link_lists;
    if (cfg.comment_enabled && result?.post_id) {
      // 1 bài = 1 gán (random hoặc lần lượt theo page)
      const assigned = assignCommentForPost(cfg);
      commentText = assigned.text;
      commentLinkLists = assigned.link_lists || cfg.link_lists;
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

export async function runOnePost(pageRowId, opts = {}) {
  return withPageOperationLock(pageRowId, () =>
    runOnePostUnlocked(pageRowId, opts)
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

export function listPostLogs({ pageRowId, limit = 100 } = {}) {
  const db = getDb();
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  if (pageRowId) {
    return db
      .prepare(
        `SELECT * FROM post_logs WHERE page_row_id = ? ORDER BY id DESC LIMIT ?`
      )
      .all(pageRowId, safeLimit);
  }
  return db
    .prepare(`SELECT * FROM post_logs ORDER BY id DESC LIMIT ?`)
    .all(safeLimit);
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
  const fromDisk = loadCaptionsFromDisk(cfg.captions_folder);
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
