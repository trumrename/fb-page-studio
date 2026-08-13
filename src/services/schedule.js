/**
 * Facebook Page scheduled posts (Graph published=false + scheduled_publish_time).
 * Bulk schedule across pages; media/caption from page config pool.
 */
import { getDb } from "../db/index.js";
import { decryptToken } from "./crypto.js";
import {
  publishText,
  publishPhoto,
  publishVideo,
  publishComment,
  listScheduledPosts,
  getFacebookPostStatus,
  extractPostLikeCount,
  validateScheduleUnix,
  forcePublishScheduledObject,
} from "./publish.js";
import path from "path";
import {
  pickCaption,
  buildComment,
  assignCommentForPost,
  composeCaptionWithLead,
} from "./mediaLibrary.js";
import { pickNextVideoTitle } from "./videoTitlePool.js";
import { getCaptionStats, getPagePostConfig, savePagePostConfig } from "./poster.js";
import {
  getActiveTimesForPageRow,
  buildSlotsFromActiveHours,
  buildSlotsFromWindows,
  parseFixedTimes,
} from "./activeTimes.js";
import { appendPostCsv } from "./postLogCsv.js";
import {
  assertCanPublish,
  pickUnusedMedia,
  finalizeMediaAfterSuccess,
  noteGraphFailure,
  enforceBulkLimits,
  ensureAntiSpamTables,
  getAntiSpamSettings,
  countUnusedMedia,
} from "./antiSpam.js";
import {
  resolvePagePostingPolicy,
  resolveMinGapMinutes,
  resolveMaxPostsPerDay,
  capSlotsByDailyQuota,
  todayYmd,
  resolveMetaScheduledPolicy,
} from "./schedulePolicy.js";
import { assertCanPublish as assertLicenseActive } from "./license.js";
import { withPageOperationLock } from "./pageOperationLock.js";
import { reserveCaptionSlot } from "./captionPoolState.js";

/**
 * Seeded PRNG (mulberry32) — cùng seed => cùng chuỗi số.
 * Dùng cho random khoảng giờ hẹn FB để dry-run (Xem kế hoạch) và chạy thật
 * ra GIỐNG nhau, tránh "mỗi lần bấm ra giờ khác".
 */
function makeSeededRng(seedStr) {
  let h = 1779033703 ^ String(seedStr).length;
  for (let i = 0; i < String(seedStr).length; i++) {
    h = Math.imul(h ^ String(seedStr).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random số phút trong [min,max] dùng rng đã seed; max<=min => trả min. */
function randBetweenSeeded(rng, min, max) {
  const a = Number(min);
  const b = Number(max);
  if (!Number.isFinite(a)) return 0;
  if (!Number.isFinite(b) || b <= a) return a;
  return a + rng() * (b - a);
}

/**
 * Ước lượng loại bài theo sequence page + force post_type bulk.
 * @returns {"photo"|"video"|"text"}
 */
function resolvePlannedPostType(cfg, slotIndex, forceType) {
  const forced = String(forceType || "").toLowerCase().trim();
  if (forced && forced !== "auto") {
    if (forced === "image") return "photo";
    if (forced === "photo" || forced === "video" || forced === "text") return forced;
  }
  const sequence =
    Array.isArray(cfg?.sequence) && cfg.sequence.length
      ? cfg.sequence
      : ["photo", "video", "text"];
  const t = String(sequence[slotIndex % sequence.length] || "photo").toLowerCase();
  if (t === "image") return "photo";
  if (t === "video" || t === "text") return t;
  return "photo";
}

/**
 * Kiểm tra đủ media (ảnh/video chưa dùng) cho toàn bộ slot kế hoạch.
 * Nhiều page dùng chung 1 folder → cộng dồn required theo folder|kind.
 */
function assessMediaForPlan(finalPlan, { postType, bodyPostType } = {}) {
  const force = postType || (bodyPostType && bodyPostType !== "auto" ? bodyPostType : null);
  const mediaNeeds = new Map(); // key folder|kind
  const pageNotes = [];
  let totalSlots = 0;
  let mediaSlots = 0;

  for (const p of finalPlan || []) {
    if (p.error || !p.slots?.length) continue;
    const cfg = getPagePostConfig(p.page_row_id);
    const folder = String(cfg?.media_folder || "").trim();
    const startSlot = Number(cfg?.next_slot_index) || 0;
    let pagePhoto = 0;
    let pageVideo = 0;
    let pageText = 0;

    for (let i = 0; i < p.slots.length; i++) {
      totalSlots += 1;
      const type = resolvePlannedPostType(cfg, startSlot + i, force);
      if (type === "text") {
        pageText += 1;
        continue;
      }
      mediaSlots += 1;
      const kind = type === "video" ? "video" : "photo";
      if (kind === "video") pageVideo += 1;
      else pagePhoto += 1;
      const folderKey = folder
        ? path.resolve(folder).toLowerCase()
        : `__empty__:${p.page_row_id}`;
      const key = `${folderKey}|${kind}`;
      if (!mediaNeeds.has(key)) {
        mediaNeeds.set(key, {
          folder: folder || null,
          kind,
          required: 0,
          available: 0,
          page_names: [],
        });
      }
      const need = mediaNeeds.get(key);
      need.required += 1;
      if (!need.page_names.includes(p.page_name)) {
        need.page_names.push(p.page_name);
      }
    }
    pageNotes.push({
      page_row_id: p.page_row_id,
      page_name: p.page_name,
      slots: p.slots.length,
      need_photo: pagePhoto,
      need_video: pageVideo,
      need_text: pageText,
      media_folder: folder || null,
    });
  }

  const pools = [];
  const shortfalls = [];
  const messages = [];

  for (const need of mediaNeeds.values()) {
    let available = 0;
    if (!need.folder) {
      available = 0;
    } else {
      try {
        available = countUnusedMedia(need.folder, need.kind);
      } catch {
        available = 0;
      }
    }
    need.available = available;
    need.ok = available >= need.required;
    need.short = Math.max(0, need.required - available);
    pools.push({ ...need });
    if (!need.ok) {
      shortfalls.push({ ...need });
      const kindLabel = need.kind === "video" ? "video" : "ảnh";
      if (!need.folder) {
        messages.push(
          `Thiếu folder media cho ${need.page_names.slice(0, 4).join(", ")}` +
            `${need.page_names.length > 4 ? "…" : ""} — cần ${need.required} ${kindLabel}`
        );
      } else {
        messages.push(
          `Thiếu ${kindLabel}: cần ${need.required}, còn ${available} trong ${need.folder}` +
            (need.page_names.length
              ? ` (page: ${need.page_names.slice(0, 5).join(", ")}${need.page_names.length > 5 ? "…" : ""})`
              : "")
        );
      }
    }
  }

  const ok = shortfalls.length === 0;
  return {
    ok,
    total_slots: totalSlots,
    media_slots: mediaSlots,
    pools,
    shortfalls,
    messages,
    pages: pageNotes,
    summary: ok
      ? totalSlots
        ? `Đủ media cho ${mediaSlots} slot cần ảnh/video (${totalSlots} slot tổng).`
        : "Không có slot để kiểm tra media."
      : `THIẾU media — ${shortfalls.length} kho không đủ. ${messages[0] || ""}`,
  };
}

function logScheduled(row) {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO post_logs (
        page_row_id, page_id, page_name, post_type, media_path, caption,
        fb_post_id, fb_post_url, day_index, status, error, comment_text, comment_id,
        scheduled_publish_time
      ) VALUES (
        @page_row_id, @page_id, @page_name, @post_type, @media_path, @caption,
        @fb_post_id, @fb_post_url, @day_index, @status, @error, @comment_text, @comment_id,
        @scheduled_publish_time
      )`
    )
    .run(row);
  const logRow = {
    id: info.lastInsertRowid,
    ...row,
    created_at: new Date().toISOString(),
  };
  try {
    appendPostCsv(logRow);
  } catch (e) {
    console.warn("[schedule csv]", e.message);
  }
  return logRow;
}

/**
 * Schedule one feed post for a page at unix time.
 * @param {number} pageRowId
 * @param {object} opts { scheduled_publish_time, post_type?, caption?, force_type? }
 */
async function scheduleOnePostUnlocked(pageRowId, opts = {}) {
  ensureAntiSpamTables();
  assertLicenseActive();
  const db = getDb();
  const page = db
    .prepare(
      `SELECT id, page_id, name, page_token_enc, status FROM fb_pages WHERE id = ?`
    )
    .get(pageRowId);
  if (!page || page.status !== "active") {
    throw new Error("Page not found or inactive");
  }

  const unix = validateScheduleUnix(
    opts.scheduled_publish_time ?? opts.unix ?? opts.at
  );
  let cfg = getPagePostConfig(pageRowId);
  const slot = cfg.next_slot_index || 0;
  const captionSlot = cfg.caption_slot_index || 0;
  const sequence =
    Array.isArray(cfg.sequence) && cfg.sequence.length
      ? cfg.sequence
      : ["photo", "text"];
  let postType = String(
    opts.post_type || opts.force_type || sequence[slot % sequence.length]
  ).toLowerCase();

  let caption = "";
  let usedPoolCaption = false;
  let mediaPath = null;
  const triedCaptions = [];
  const captionPoolTotal = getCaptionStats(cfg).total;
  const maxCaptionAttempts = Math.max(1, captionPoolTotal || 1);
  // Reserve caption slot ONCE before loop — retries use slot offset so DB
  // counter is not burned on every attempt (Bug #2 fix).
  const manualCaption0 = opts.caption != null && String(opts.caption).trim();
  const baseReservation = !manualCaption0
    ? reserveCaptionSlot({
        captionsFolder: cfg.captions_folder,
        captions: cfg.captions,
        pageRowId,
      })
    : { slot_index: captionSlot };
  let selectedCaptionSlot = baseReservation.slot_index;
  for (let attempt = 0; attempt < maxCaptionAttempts; attempt++) {
    const manualCaption = manualCaption0;
    caption =
      manualCaption
        ? String(opts.caption).trim()
        : pickCaption(
            cfg.captions,
            selectedCaptionSlot + attempt,
            "sequential_shuffle",
            cfg.captions_folder,
            triedCaptions
          );
    if (caption && !manualCaption) triedCaptions.push(caption);
    usedPoolCaption = !manualCaption;
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
    }
    const gate = assertCanPublish({
      pageRowId,
      pageId: page.page_id,
      caption,
      mediaPath: postType === "text" ? null : mediaPath,
      ignore_quota: false,
      ignore_interval: false,
      isSchedule: true,
      scheduledAtUnix: unix,
    });
    if (gate.ok && caption) break;
    if (gate.ok && !caption) break;
    if (
      [
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
    if (manualCaption || attempt === maxCaptionAttempts - 1 || !caption) {
      if (gate.code === "CAPTION_DUP" || triedCaptions.length) {
        throw new Error(
          `Hết caption khả dụng trong kho (đã dùng / trùng trong cửa sổ anti-spam). ` +
            `Đã thử ${triedCaptions.length}/${captionPoolTotal || 0} caption. Thêm dòng vào kho Caption (.txt/.csv).` +
            (gate.error ? ` — ${gate.error}` : "")
        );
      }
      throw new Error(gate.error || "Không chọn được caption để hẹn giờ");
    }
    mediaPath = null;
  }

  // Dòng mở đầu (view full album : + link) rồi caption kho
  const leadPack = composeCaptionWithLead(caption, cfg);
  caption = leadPack.text || caption;
  if (leadPack.link_lists) {
    cfg = { ...cfg, link_lists: leadPack.link_lists };
  }

  const pageToken = decryptToken(page.page_token_enc);
  const schedule = { scheduled_publish_time: unix };
  let movedPath = null;
  let result = null;
  let fin = { movedPath: null, hash: null };

  try {
    if (postType === "text") {
      if (!caption) {
        throw new Error(
          "Hẹn text cần caption trong kho .txt/.csv hoặc inline — không bịa nội dung"
        );
      }
      result = await publishText(page.page_id, pageToken, caption, schedule);
    } else if (postType === "photo" || postType === "image") {
      if (!mediaPath) {
        if (caption && opts.allow_text_fallback !== false) {
          postType = "text";
          result = await publishText(page.page_id, pageToken, caption, schedule);
        } else {
          throw new Error(`Không có ảnh chưa dùng trong: ${cfg.media_folder || "(trống)"}`);
        }
      } else {
        result = await publishPhoto(
          page.page_id,
          pageToken,
          mediaPath,
          caption || "",
          schedule
        );
      }
    } else if (postType === "video") {
      if (!mediaPath) {
        throw new Error(`Không có video chưa dùng: ${cfg.media_folder || "(trống)"}`);
      }
      // Hẹn giờ Facebook (Graph) — cùng path ảnh/text. Video một số page public OK.
      // Title Meta tùy chọn (kho title xoay vòng) — caption full vẫn ở description.
      const titlePick = pickNextVideoTitle(cfg);
      result = await publishVideo(
        page.page_id,
        pageToken,
        mediaPath,
        caption || "",
        schedule,
        { title: titlePick.title || null }
      );
    } else {
      throw new Error(`Loại bài không hỗ trợ hẹn giờ: ${postType}`);
    }

    // Media: hash forever + move to posted immediately after FB accepts schedule
    if (mediaPath && postType !== "text") {
      fin = finalizeMediaAfterSuccess({
        mediaPath,
        postedFolder: cfg.posted_folder,
        page_row_id: pageRowId,
        page_id: page.page_id,
        fb_post_id: result?.post_id,
        caption,
      });
      movedPath = fin.movedPath;
    } else if (caption) {
      fin = finalizeMediaAfterSuccess({
        mediaPath: null,
        postedFolder: cfg.posted_folder,
        page_row_id: pageRowId,
        page_id: page.page_id,
        fb_post_id: result?.post_id,
        caption,
      });
    }

    // Auto comment: mỗi bài full = 1 link (random hoặc lần lượt trong list của page).
    // - comment_when=immediate (MẶC ĐỊNH): Graph comment NGAY sau khi hẹn API
    // - comment_when=after_publish: chỉ gửi khi bài publish (+ delay/like; cần tool mở)
    let pendingComment = null;
    let commentIdNow = null;
    let commentWhen = "immediate";
    let commentImmediateError = null;
    let commentLinkLists = cfg.link_lists;
    if (cfg.comment_enabled) {
      const assigned = assignCommentForPost(cfg);
      pendingComment = assigned.text;
      commentLinkLists = assigned.link_lists || cfg.link_lists;
      // Default IMMEDIATE — thiếu field trên page cũ = comment ngay (đúng “sau khi đăng API”)
      const whenRaw = String(
        commentLinkLists?.comment_when || cfg.link_lists?.comment_when || "immediate"
      )
        .trim()
        .toLowerCase();
      commentWhen =
        whenRaw === "after_publish" ||
        whenRaw === "publish" ||
        whenRaw === "sau_publish" ||
        whenRaw === "when_published"
          ? "after_publish"
          : "immediate";

      if (pendingComment && commentWhen === "immediate" && result?.post_id) {
        try {
          const c = await publishComment(result.post_id, pageToken, pendingComment);
          commentIdNow = c.comment_id || null;
        } catch (ce) {
          // FB thường chặn comment bài unpublished → giữ pending, gửi ngay khi publish (reconcile)
          commentImmediateError = ce.message || String(ce);
          commentIdNow = null;
        }
      }
    }

    // Do NOT write future scheduled time into last_post_at (would block Direct Local forever).
    // Quota/interval for Direct Local read post_logs (scheduled + direct) via schedulePolicy.
    savePagePostConfig(pageRowId, {
      ...cfg,
      link_lists: commentLinkLists,
      next_slot_index: slot + 1,
      caption_slot_index: usedPoolCaption && caption ? selectedCaptionSlot + 1 : captionSlot,
    });

    const scheduledIso = new Date(unix * 1000).toISOString();
    const log = logScheduled({
      page_row_id: pageRowId,
      page_id: page.page_id,
      page_name: page.name,
      post_type: postType,
      media_path: movedPath || mediaPath,
      caption: caption || null,
      fb_post_id: result.post_id,
      fb_post_url: result.post_url,
      day_index: null,
      status: "scheduled",
      error: commentImmediateError
        ? `Comment ngay fail (sẽ thử lại sau publish): ${commentImmediateError}`
        : null,
      // Nếu comment ngay OK → đã có comment_id; không thì pending đến lúc publish
      comment_text: pendingComment || null,
      comment_id: commentIdNow,
      scheduled_publish_time: scheduledIso,
    });

    return {
      ok: true,
      scheduled: true,
      post_type: postType,
      scheduled_publish_time: unix,
      scheduled_at_iso: scheduledIso,
      post: result,
      log,
      media_moved_to: movedPath,
      media_hash: fin.hash,
      comment_pending: Boolean(pendingComment) && !commentIdNow,
      comment_immediate: Boolean(commentIdNow),
      comment_when: commentWhen,
      comment_id: commentIdNow,
      comment_error: commentImmediateError,
      comment_text_preview: pendingComment
        ? String(pendingComment).slice(0, 120)
        : null,
      page: { id: page.id, page_id: page.page_id, name: page.name },
    };
  } catch (e) {
    // Only Graph API failures trigger backoff — not local validation (caption/media empty etc.)
    const isGraphFail =
      !!e.fb ||
      e.code === 4 ||
      e.code === 17 ||
      /graph|facebook|oauth|rate limit|spam|#\d+/i.test(String(e.message || ""));
    const isLocalValidation =
      /caption|media|inbox|kho|quota|interval|cooldown|anti-spam|hết caption|không có ảnh|không có video/i.test(
        String(e.message || "")
      );
    if (isGraphFail && !isLocalValidation) {
      noteGraphFailure(e);
    }
    const log = logScheduled({
      page_row_id: pageRowId,
      page_id: page.page_id,
      page_name: page.name,
      post_type: postType,
      media_path: mediaPath,
      caption: caption || null,
      fb_post_id: null,
      fb_post_url: null,
      day_index: null,
      status: "schedule_fail",
      error: e.message,
      comment_text: null,
      comment_id: null,
      scheduled_publish_time: new Date(unix * 1000).toISOString(),
    });
    return {
      ok: false,
      scheduled: false,
      error: e.message,
      fb: e.fb || null,
      log,
      post_type: postType,
      scheduled_publish_time: unix,
      page: { id: page.id, page_id: page.page_id, name: page.name },
    };
  }
}

export async function scheduleOnePost(pageRowId, opts = {}) {
  return withPageOperationLock(pageRowId, () =>
    scheduleOnePostUnlocked(pageRowId, opts)
  );
}

/**
 * Bulk schedule.
 * body:
 *  - page_row_ids: number[]
 *  - mode: 'active_times' | 'fixed'
 *  - post_type?: 'photo'|'video'|'text'|'auto'
 *  - tz_offset_minutes?: number (default 420 = UTC+7)
 *  - // active_times:
 *  - days_ahead?: number (1-30)
 *  - posts_per_day?: number
 *  - force_active?: boolean
 *  - // fixed:
 *  - times?: string[] ISO or "YYYY-MM-DD HH:mm"
 *  - start_at?: string
 *  - count_per_page?: number  (bài / page / ngày khi multi-day)
 *  - days_ahead?: number (1-30) — hẹn nhiều ngày (cả fixed + active_times)
 *  - interval_minutes?: number
 *  - interval_minutes_min/max?: number — cách giữa 2 bài cùng page
 *  - page_gap_minutes_min/max?: number — cách giữa page A và page B (stagger)
 *  - dry_run?: boolean — only return planned slots
 */
export async function scheduleBulk(body = {}) {
  const pageIds = Array.isArray(body.page_row_ids)
    ? body.page_row_ids.map(Number).filter((n) => n > 0)
    : [];
  if (!pageIds.length) {
    throw new Error("Chọn ít nhất 1 page (page_row_ids)");
  }

  const mode =
    body.mode === "fixed"
      ? "fixed"
      : body.mode === "windows"
        ? "windows"
        : "active_times";
  const tz = Number.isFinite(Number(body.tz_offset_minutes))
    ? Number(body.tz_offset_minutes)
    : 420;
  const postType =
    body.post_type && body.post_type !== "auto" ? body.post_type : null;
  const dryRun = !!body.dry_run;

  const plan = []; // { page_row_id, page_name, slots: Date[], active?, error? }
  const antiGlobal = getAntiSpamSettings();
  const antiOn = !!antiGlobal.enabled;

  // Page A → Page B gap (phút). User-configurable; fallback anti-spam jitter.
  const legacyStep = antiOn
    ? Math.min(12, Math.max(3, Number(antiGlobal.jitter_minutes_min) || 3))
    : 5;
  let pageGapMin = Number(
    body.page_gap_minutes_min ?? body.page_stagger_min ?? body.page_stagger_minutes
  );
  let pageGapMax = Number(
    body.page_gap_minutes_max ?? body.page_stagger_max ?? body.page_stagger_minutes
  );
  if (!Number.isFinite(pageGapMin) || pageGapMin < 0) pageGapMin = legacyStep;
  if (!Number.isFinite(pageGapMax) || pageGapMax < pageGapMin) {
    pageGapMax = pageGapMin;
  }
  pageGapMin = Math.min(24 * 60, Math.max(0, Math.round(pageGapMin)));
  pageGapMax = Math.min(24 * 60, Math.max(pageGapMin, Math.round(pageGapMax)));

  // Cumulative offset per page index: page0=0, page1=gap1, page2=gap1+gap2…
  const pageStaggerRng = makeSeededRng(
    `pagegap.${pageIds.join(",")}.${pageGapMin}.${pageGapMax}`
  );
  const pageStaggers = [0];
  for (let i = 1; i < pageIds.length; i++) {
    const gap =
      pageGapMax > pageGapMin
        ? Math.round(randBetweenSeeded(pageStaggerRng, pageGapMin, pageGapMax))
        : pageGapMin;
    pageStaggers.push(pageStaggers[i - 1] + gap);
  }
  const staggerStep =
    pageIds.length > 1
      ? Math.round(pageStaggers[pageStaggers.length - 1] / (pageIds.length - 1))
      : pageGapMin;

  let pageIndex = 0;
  // Khi anti-spam OFF, tự động bỏ cap ngày — user tắt anti = muốn đăng tự do
  const ignorePageCap = !!body.ignore_page_quota || !antiOn;
  // Hẹn giờ cố định: tôn trọng đúng giờ/khoảng cách người dùng nhập,
  // KHÔNG cộng jitter ngẫu nhiên, KHÔNG ép min-gap của page.
  // Mặc định bật cho mode "fixed"; có thể tắt bằng body.strict_timing === false.
  const strictTiming =
    body.strict_timing != null ? !!body.strict_timing : mode === "fixed";
  // Multi-day: default 3 for active_times; default 1 for fixed unless body sets days
  const daysAhead = Math.min(
    30,
    Math.max(
      1,
      Number(body.days_ahead) ||
        (mode === "fixed" ? 1 : 3)
    )
  );
  const requestedPerDay = body.posts_per_day != null ? Number(body.posts_per_day) : null;

  for (const pageRowId of pageIds) {
    const db = getDb();
    const page = db
      .prepare(`SELECT id, name FROM fb_pages WHERE id = ? AND status = 'active'`)
      .get(pageRowId);
    if (!page) {
      plan.push({
        page_row_id: pageRowId,
        page_name: "?",
        slots: [],
        error: "Page not found",
      });
      continue;
    }

    let slots = [];
    let activeMeta = null;
    let policyMeta = null;
    const pageStagger = pageStaggers[pageIndex] ?? pageIndex * pageGapMin;
    pageIndex += 1;

    // Shared policy
    const policy = resolvePagePostingPolicy(pageRowId, {
      tzOffsetMinutes: tz,
      postsPerDay: requestedPerDay,
      ignorePageCap,
    });
    policyMeta = {
      max_posts_per_day: policy.max_posts_per_day,
      max_posts_per_day_effective: policy.max_posts_per_day_effective,
      interval_minutes: policy.interval_minutes,
      min_gap_minutes: policy.min_gap_minutes,
      used_today: policy.used_today,
      remaining_today: policy.remaining_today,
      preferred_hours: policy.preferred_hours,
      notes: policy.notes,
    };

    // Page post config (dùng chung cho mọi mode)
    const cfg = getPagePostConfig(pageRowId);
    // Min gap dùng chung cho mọi mode (trước đây chỉ khai báo trong nhánh
    // "fixed" nên nhánh "windows" tham chiếu minGap → ReferenceError).
    const minGap = resolveMinGapMinutes(cfg, antiGlobal);

    // Meta official scheduled policy (if set)
    const metaPolicy = resolveMetaScheduledPolicy(cfg, antiGlobal);
    policyMeta.meta_scheduled = {
      max_scheduled_per_day: metaPolicy.max_scheduled_per_day,
      publish_window_days: metaPolicy.publish_window_days,
      min_interval_minutes: metaPolicy.min_interval_minutes,
      retry_backoff_seconds: metaPolicy.retry_backoff_seconds,
    };

    if (mode === "fixed") {
      if (Array.isArray(body.times) && body.times.length) {
        // List thời điểm = mốc gốc (HH:mm hoặc đủ ngày). Page 0 = đúng giờ.
        // Page N = giờ + pageStagger. Khoảng giữa các dòng list giữ nguyên.
        slots = parseFixedTimes(body.times, tz).map(
          (d) => new Date(d.getTime() + pageStagger * 60 * 1000)
        );
      } else if (body.start_at) {
        // count_per_page = bài / page / ngày; nhân với days_ahead (hẹn nhiều ngày)
        const rawCount = Math.min(50, Math.max(1, Number(body.count_per_page) || 1));
        const countPerDay = ignorePageCap
          ? rawCount
          : Math.min(rawCount, policy.max_posts_per_day_effective);
        // strictTiming: dùng đúng interval người dùng nhập (chỉ chặn tối thiểu 10p
        // theo giới hạn Graph). Không ép min-gap của page đè lên.
        // Khoảng cách bài–bài CÙNG page: interval_minutes_min/max
        const rawMin = Number(body.interval_minutes_min);
        const rawMax = Number(body.interval_minutes_max);
        const fallbackInterval =
          Number(body.interval_minutes) || policy.interval_minutes || 120;
        let intervalMin = Math.max(10, Number.isFinite(rawMin) ? rawMin : fallbackInterval);
        let intervalMax = Math.max(
          intervalMin,
          Number.isFinite(rawMax) ? rawMax : intervalMin
        );
        if (!strictTiming) {
          intervalMin = Math.max(minGap, intervalMin);
          intervalMax = Math.max(intervalMin, intervalMax);
        }
        const randomizeInterval = intervalMax > intervalMin;
        const rng = makeSeededRng(
          `${pageRowId}.${body.start_at}.${countPerDay}.${daysAhead}.${intervalMin}.${intervalMax}`
        );
        const startList = parseFixedTimes([body.start_at], tz);
        if (!startList.length) {
          plan.push({
            page_row_id: pageRowId,
            page_name: page.name,
            slots: [],
            policy: policyMeta,
            error: "start_at không parse được",
          });
          continue;
        }
        const day0Ms = startList[0].getTime();
        const dayMs = 24 * 60 * 60 * 1000;
        // Multi-day: mỗi ngày lặp lại countPerDay bài, cùng giờ bắt đầu + interval
        for (let d = 0; d < daysAhead; d++) {
          let t = day0Ms + d * dayMs + pageStagger * 60 * 1000;
          for (let i = 0; i < countPerDay; i++) {
            slots.push(new Date(t));
            const stepMin = randomizeInterval
              ? randBetweenSeeded(rng, intervalMin, intervalMax)
              : intervalMin;
            t += Math.round(stepMin) * 60 * 1000;
          }
        }
      } else {
        plan.push({
          page_row_id: pageRowId,
          page_name: page.name,
          slots: [],
          policy: policyMeta,
          error: "mode fixed cần times[] hoặc start_at",
        });
        continue;
      }
      // Enforce min gap between fixed slots (bỏ qua khi strictTiming — tôn trọng giờ nhập)
      if (!strictTiming && minGap > 0 && slots.length > 1) {
        slots.sort((a, b) => a.getTime() - b.getTime());
        const gapMs = minGap * 60 * 1000;
        const out = [slots[0]];
        for (let i = 1; i < slots.length; i++) {
          let t = slots[i].getTime();
          const prev = out[out.length - 1].getTime();
          if (t < prev + gapMs) t = prev + gapMs;
          out.push(new Date(t));
        }
        slots = out;
      }
      activeMeta = {
        source: "fixed",
        timing_source: Array.isArray(body.times) && body.times.length
          ? "list_times"
          : "start_at_interval",
        list_times: Array.isArray(body.times) && body.times.length
          ? body.times.length
          : 0,
        min_gap_minutes: minGap,
        page_stagger_minutes: pageStagger,
        page_gap_minutes_min: pageGapMin,
        page_gap_minutes_max: pageGapMax,
        days_ahead: daysAhead,
        anti_spam_enabled: antiOn,
      };
    } else if (mode === "windows") {
      // windows — random giờ trong từng khung (vd Sáng 07:30–11:30, Tối 18:00–21:30)
      // Mỗi ngày sinh giờ random khác nhau, không cố định như active_times
      const wins = Array.isArray(body.windows) ? body.windows : [];
      if (!wins.length) {
        plan.push({
          page_row_id: pageRowId,
          page_name: page.name,
          slots: [],
          policy: policyMeta,
          error: "mode windows cần windows: [{name?, start, end, posts}]",
        });
        continue;
      }
      // Seed theo page + ngày + cấu hình windows => dry-run và chạy thật ra cùng giờ
      const seedStr = `${pageRowId}.${daysAhead}.${JSON.stringify(wins)}`;
      slots = buildSlotsFromWindows(wins, {
        daysAhead,
        tzOffsetMinutes: tz,
        pageStaggerMinutes: pageStagger,
        minGapMinutes: minGap,
        seed: seedStr,
      });
      activeMeta = {
        source: "windows",
        windows: wins,
        page_stagger_minutes: pageStagger,
        anti_spam_enabled: antiOn,
        posts_per_day_effective: wins.reduce((s, w) => s + (Number(w.posts) || 1), 0),
      };
      if (!slots.length) {
        plan.push({
          page_row_id: pageRowId,
          page_name: page.name,
          slots: [],
          active: activeMeta,
          policy: policyMeta,
          error:
            "Slot trống (tất cả khung giờ đã qua hôm nay). Tăng số ngày hoặc điều chỉnh khung giờ.",
        });
        continue;
      }
    } else {
      // active_times — giờ ưa thích / preset từng page (same hours as Direct Local preferred)
      const active = await getActiveTimesForPageRow(pageRowId, {
        force: !!body.force_active,
      });
      activeMeta = {
        ok: active.ok,
        top_hours: active.top_hours,
        peak_hour: active.peak_hour,
        metric: active.metric,
        source: active.source || null,
        auto_seeded_preferred: !!active.auto_seeded_preferred,
        error: active.error || null,
        cached: active.cached,
      };
      if (!active.ok || !active.top_hours?.length) {
        plan.push({
          page_row_id: pageRowId,
          page_name: page.name,
          slots: [],
          active: activeMeta,
          policy: policyMeta,
          error:
            active.error ||
            "Không có giờ đăng — lưu giờ ưa thích (vd 9,12,19,21) hoặc dùng mode cố định",
        });
        continue;
      }

      const minGap = policy.min_gap_minutes;
      // posts/day: bulk form request capped by page max_posts_per_day (+ anti cap)
      const postsPerDay = resolveMaxPostsPerDay(
        { max_posts_per_day: policy.max_posts_per_day },
        antiGlobal,
        requestedPerDay != null ? requestedPerDay : policy.max_posts_per_day,
        { ignorePageCap }
      );

      slots = buildSlotsFromActiveHours(active.top_hours, {
        daysAhead,
        postsPerDay,
        tzOffsetMinutes: tz,
        minGapMinutes: minGap,
        jitterMinutes: antiOn
          ? Math.max(5, Number(antiGlobal.jitter_minutes_min) || 5)
          : 10,
        pageStaggerMinutes: pageStagger,
      });
      activeMeta = {
        ...activeMeta,
        preferred_hours: active.preferred_hours || active.top_hours,
        min_gap_minutes: minGap,
        posts_per_day_effective: postsPerDay,
        page_stagger_minutes: pageStagger,
        anti_spam_enabled: antiOn,
      };
      if (!slots.length) {
        plan.push({
          page_row_id: pageRowId,
          page_name: page.name,
          slots: [],
          active: activeMeta,
          policy: policyMeta,
          error:
            "Slot trống (giờ peak đã qua hôm nay hoặc ngoài cửa sổ 10p–30 ngày). Thử tăng số ngày / đổi giờ ưa thích.",
        });
        continue;
      }
    }

    // filter valid Graph window: 10 min .. 30 days
    const now = Date.now();
    const slotsBeforeWindow = slots.length;
    const tooSoon = slots.filter((d) => d.getTime() < now + 10 * 60 * 1000).length;
    const tooFar = slots.filter(
      (d) => d.getTime() > now + 30 * 24 * 60 * 60 * 1000
    ).length;
    slots = slots.filter(
      (d) =>
        d.getTime() >= now + 10 * 60 * 1000 &&
        d.getTime() <= now + 30 * 24 * 60 * 60 * 1000
    );

    // Cap by page daily quota (today = remaining after direct + already-scheduled)
    // ignorePageCap (tick "bỏ giới hạn bài/ngày" hoặc anti-spam OFF) phải bỏ luôn
    // cap của HÔM NAY. Trước đây vẫn truyền policy.remaining_today, nên page đã
    // đăng đủ max/ngày => remaining=0 => mọi slot hôm nay bị trim.
    const capped = capSlotsByDailyQuota(slots, {
      maxPerDay: policy.max_posts_per_day_effective,
      remainingToday: ignorePageCap
        ? policy.max_posts_per_day_effective
        : policy.remaining_today,
      todayYmd: policy.today_ymd || todayYmd(tz),
      tzOffsetMinutes: tz,
    });
    slots = capped.slots;
    policyMeta = {
      ...policyMeta,
      ignore_page_quota: ignorePageCap,
      quota_trimmed_slots: capped.trimmed,
      used_per_day_plan: capped.used_per_day,
      slots_before_window_filter: slotsBeforeWindow,
      slots_dropped_too_soon: tooSoon,
      slots_dropped_too_far: tooFar,
    };

    // Thông báo lỗi phải nói ĐÚNG nguyên nhân, không gộp thành "Không còn slot hợp lệ".
    let slotError = null;
    if (!slots.length) {
      if (capped.trimmed) {
        slotError =
          `Hết quota ngày (max ${policy.max_posts_per_day_effective}/ngày, hôm nay đã dùng ` +
          `${policy.used_today}, còn ${policy.remaining_today}). ` +
          `Tick "Bỏ giới hạn bài/ngày" hoặc tăng max bài/ngày của page.`;
      } else if (!slotsBeforeWindow) {
        slotError =
          mode === "fixed"
            ? "Không sinh được mốc giờ nào — kiểm tra Start at / số bài / list thời điểm."
            : "Không sinh được mốc giờ nào — kiểm tra giờ ưa thích / khung giờ.";
      } else if (tooSoon && !tooFar) {
        slotError =
          `Tất cả ${tooSoon} mốc giờ đã ở quá khứ hoặc quá gần (Facebook yêu cầu ≥ 10 phút ` +
          `kể từ hiện tại). Đổi "Start at" sang giờ tương lai.`;
      } else if (tooFar && !tooSoon) {
        slotError = `Tất cả ${tooFar} mốc giờ vượt 30 ngày — giới hạn hẹn giờ của Facebook.`;
      } else {
        slotError =
          `Không mốc giờ nào nằm trong cửa sổ hợp lệ của Facebook ` +
          `(≥ 10 phút và ≤ 30 ngày): ${tooSoon} quá gần/quá khứ, ${tooFar} quá xa.`;
      }
    }

    plan.push({
      page_row_id: pageRowId,
      page_name: page.name,
      slots,
      active: activeMeta,
      policy: policyMeta,
      page_stagger_minutes: pageStagger,
      error: slotError,
    });
  }

  // Anti-spam: hard bulk caps + jitter (skipped entirely when anti-spam OFF)
  const limited = enforceBulkLimits(plan, { ...body, strict_timing: strictTiming });
  const finalPlan = limited.plan;

  const timingSource =
    body.timing_source ||
    (mode === "fixed"
      ? Array.isArray(body.times) && body.times.length
        ? "list_times"
        : "start_at_interval"
      : mode === "windows"
        ? "windows"
        : "active_times");

  /** Tính đủ/thiếu media (ảnh/video) theo sequence + slot — gom theo folder chung */
  const mediaCheck = assessMediaForPlan(finalPlan, {
    postType,
    bodyPostType: body.post_type,
  });

  if (dryRun) {
    return {
      dry_run: true,
      mode,
      timing_source: timingSource,
      tz_offset_minutes: tz,
      anti_spam_enabled: antiOn,
      anti_spam_trimmed: limited.trimmed,
      anti_spam_caps: limited.caps || null,
      page_stagger_step_minutes: staggerStep,
      page_gap_minutes_min: pageGapMin,
      page_gap_minutes_max: pageGapMax,
      page_staggers: pageStaggers,
      days_ahead: daysAhead,
      media_check: mediaCheck,
      media_ok: mediaCheck.ok,
      policy_note:
        "Giờ / gap / max bài/ngày lấy từ cấu hình Page + anti-spam. " +
        `Cách page A→B: ${pageGapMin}–${pageGapMax}p · hẹn ${daysAhead} ngày. ` +
        "Mode này = hẹn giờ Facebook (Graph). " +
        "Muốn chờ giờ rồi đăng trực tiếp (tool mở): dùng mode đăng trực tiếp / Direct Local.",
      plan: finalPlan.map((p) => ({
        ...p,
        slots: (p.slots || []).map((d) => ({
          iso: d.toISOString(),
          unix: Math.floor(d.getTime() / 1000),
          local_label: formatLocal(d, tz),
        })),
      })),
    };
  }

  // Chặn đăng khi thiếu media (trừ khi ignore_media_check)
  if (!mediaCheck.ok && !body.ignore_media_check) {
    const err = new Error(
      mediaCheck.messages?.[0] ||
        `Thiếu media: cần thêm tài nguyên trước khi hẹn/đăng (${mediaCheck.shortfalls?.length || 0} kho thiếu)`
    );
    err.code = "MEDIA_SHORT";
    err.media_check = mediaCheck;
    throw err;
  }

  const results = [];
  for (const p of finalPlan) {
    if (p.error || !p.slots.length) {
      results.push({
        page_row_id: p.page_row_id,
        page_name: p.page_name,
        ok: false,
        error: p.error || "no slots",
        active: p.active,
        items: [],
      });
      continue;
    }
    const items = [];
    for (const slot of p.slots) {
      const unix = Math.floor(slot.getTime() / 1000);
      const r = await scheduleOnePost(p.page_row_id, {
        scheduled_publish_time: unix,
        post_type: postType || undefined,
      });
      items.push({
        ok: r.ok,
        scheduled_at_iso: r.scheduled_at_iso,
        local_label: formatLocal(slot, tz),
        post_type: r.post_type,
        post_id: r.post?.post_id || null,
        error: r.error || null,
        caption: r.log?.caption || null,
        // Every successful schedule should get its own link/comment (not only first)
        comment_pending: !!r.comment_pending,
        comment_immediate: !!r.comment_immediate,
        comment_when: r.comment_when || null,
        comment_id: r.comment_id || null,
        comment_error: r.comment_error || null,
        comment_preview: r.comment_text_preview || r.log?.comment_text || null,
      });
      // Gentle on Graph; slightly longer when anti ON
      await sleep(antiOn ? 450 : 300);
    }
    results.push({
      page_row_id: p.page_row_id,
      page_name: p.page_name,
      ok: items.some((i) => i.ok),
      active: p.active,
      items,
      scheduled_ok: items.filter((i) => i.ok).length,
      scheduled_fail: items.filter((i) => !i.ok).length,
    });
  }

  return {
    dry_run: false,
    mode,
    timing_source: timingSource,
    tz_offset_minutes: tz,
    anti_spam_enabled: antiOn,
    anti_spam_trimmed: limited.trimmed,
    anti_spam_caps: limited.caps || null,
    page_stagger_step_minutes: staggerStep,
    page_gap_minutes_min: pageGapMin,
    page_gap_minutes_max: pageGapMax,
    days_ahead: daysAhead,
    media_check: mediaCheck,
    media_ok: mediaCheck.ok,
    results,
    total_ok: results.reduce((n, r) => n + (r.scheduled_ok || 0), 0),
    total_fail: results.reduce((n, r) => n + (r.scheduled_fail || 0), 0),
  };
}

function formatLocal(date, tzOffsetMin) {
  const ms = date.getTime() + tzOffsetMin * 60 * 1000;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} (UTC${tzOffsetMin >= 0 ? "+" : ""}${tzOffsetMin / 60})`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** List FB scheduled posts for one page row */
export async function listFbScheduledForPage(pageRowId) {
  const db = getDb();
  const page = db
    .prepare(
      `SELECT id, page_id, name, page_token_enc, status FROM fb_pages WHERE id = ?`
    )
    .get(pageRowId);
  if (!page || page.status !== "active") {
    throw new Error("Page not found");
  }
  const token = decryptToken(page.page_token_enc);
  const posts = await listScheduledPosts(page.page_id, token);
  return {
    page: { id: page.id, page_id: page.page_id, name: page.name },
    posts,
  };
}

/** Read delay/min-likes from page link_lists (defaults 0 = off). */
function getCommentWaitRules(cfg) {
  const ll = cfg?.link_lists || {};
  // Only apply delay/likes when mode is after_publish
  const whenRaw = String(ll.comment_when || "immediate").trim().toLowerCase();
  const afterPublish =
    whenRaw === "after_publish" ||
    whenRaw === "publish" ||
    whenRaw === "sau_publish" ||
    whenRaw === "when_published";
  if (!afterPublish) {
    // immediate mode (or missing): no artificial wait — comment ASAP after publish fallback
    return { delayMin: 0, minLikes: 0, afterPublish: false };
  }
  const delayMin = Math.max(
    0,
    Math.min(7 * 24 * 60, Number(ll.comment_delay_minutes) || 0)
  );
  const minLikes = Math.max(0, Math.min(1_000_000, Number(ll.comment_min_likes) || 0));
  return { delayMin, minLikes, afterPublish: true };
}

/**
 * True when enough time passed after scheduled publish + optional like threshold.
 * @returns {{ ready: boolean, reason?: string, likes?: number, delay_min?: number, min_likes?: number, ready_at?: string }}
 */
function evaluateCommentReady(row, cfg, fbStatus = null) {
  const { delayMin, minLikes } = getCommentWaitRules(cfg);
  const publishMs = Date.parse(row.scheduled_publish_time || "") || 0;
  const readyAtMs = publishMs + delayMin * 60 * 1000;
  if (delayMin > 0 && Date.now() < readyAtMs) {
    return {
      ready: false,
      reason: "delay",
      delay_min: delayMin,
      min_likes: minLikes,
      ready_at: new Date(readyAtMs).toISOString(),
    };
  }
  if (minLikes > 0) {
    const likes = extractPostLikeCount(fbStatus);
    if (likes < minLikes) {
      return {
        ready: false,
        reason: "likes",
        likes,
        delay_min: delayMin,
        min_likes: minLikes,
      };
    }
    return { ready: true, likes, delay_min: delayMin, min_likes: minLikes };
  }
  return { ready: true, delay_min: delayMin, min_likes: minLikes };
}

/**
 * After a scheduled post is live on FB: post pending auto-comment (if any).
 * Supports: delay minutes after publish + min likes before comment.
 * Returns { commented, comment_id, comment_text, error?, waiting? }.
 */
async function applyPendingCommentForLog(row, token, fbStatus = null) {
  const db = getDb();
  // Already commented
  if (row.comment_id) {
    return { commented: true, comment_id: row.comment_id, comment_text: row.comment_text, skipped: true };
  }
  // Failed marker — don't loop forever
  if (row.comment_text && String(row.comment_text).startsWith("[comment failed]")) {
    return { commented: false, skipped: true, error: "previous comment fail" };
  }

  const cfg = getPagePostConfig(row.page_row_id);
  if (!cfg.comment_enabled && !(row.comment_text && String(row.comment_text).trim())) {
    return { commented: false, skipped: true, reason: "comment_disabled" };
  }

  // Need fresh engagement when min_likes > 0
  const { minLikes } = getCommentWaitRules(cfg);
  let fb = fbStatus;
  if (minLikes > 0 && row.fb_post_id) {
    try {
      fb = await getFacebookPostStatus(row.fb_post_id, token);
    } catch {
      /* use existing */
    }
  }

  const gate = evaluateCommentReady(row, cfg, fb);
  if (!gate.ready) {
    return {
      commented: false,
      waiting: true,
      reason: gate.reason,
      likes: gate.likes,
      delay_min: gate.delay_min,
      min_likes: gate.min_likes,
      ready_at: gate.ready_at || null,
    };
  }

  let message = row.comment_text && String(row.comment_text).trim() ? String(row.comment_text).trim() : null;
  if (!message) {
    // No pre-assigned text (old rows / enabled later): assign now (advances sequential cursor)
    if (!cfg.comment_enabled) {
      return { commented: false, skipped: true, reason: "comment_disabled" };
    }
    const assigned = assignCommentForPost(cfg);
    message = assigned.text;
    if (assigned.link_lists) {
      savePagePostConfig(row.page_row_id, { ...cfg, link_lists: assigned.link_lists });
    }
  }
  if (!message || !row.fb_post_id) {
    return { commented: false, skipped: true, reason: "no_message_or_post" };
  }

  try {
    const c = await publishComment(row.fb_post_id, token, message);
    db.prepare(
      `UPDATE post_logs SET comment_text = ?, comment_id = ? WHERE id = ?`
    ).run(message, c.comment_id || null, row.id);
    return {
      commented: true,
      comment_id: c.comment_id || null,
      comment_text: message,
      likes: gate.likes,
      delay_min: gate.delay_min,
    };
  } catch (e) {
    const failText = `[comment failed] ${message}`;
    db.prepare(
      `UPDATE post_logs SET comment_text = ?, comment_id = NULL, error = COALESCE(error, ?) WHERE id = ?`
    ).run(failText, `Auto comment: ${e.message || e}`, row.id);
    return {
      commented: false,
      error: e.message || String(e),
      comment_text: failText,
    };
  }
}

/** Reconcile overdue local scheduled logs against the Facebook object. */
export async function reconcileScheduledLogs({ limit = 50 } = {}) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT l.id, l.page_row_id, l.page_id, l.page_name, l.fb_post_id, l.fb_post_url,
           l.scheduled_publish_time, l.comment_text, l.comment_id, p.page_token_enc
    FROM post_logs l
    JOIN fb_pages p ON p.id = l.page_row_id
    WHERE l.status IN ('scheduled', 'schedule_overdue')
      AND l.fb_post_id IS NOT NULL
      AND julianday(l.scheduled_publish_time) <= julianday('now')
    ORDER BY CASE WHEN l.status = 'scheduled' THEN 0 ELSE 1 END,
             l.scheduled_publish_time ASC
    LIMIT ?
  `).all(Math.min(100, Math.max(1, Number(limit) || 50)));

  const results = [];
  const pendingByPage = new Map();
  let commentsOk = 0;
  let commentsFail = 0;
  for (const row of rows) {
    try {
      const token = decryptToken(row.page_token_enc);
      if (!pendingByPage.has(row.page_row_id)) {
        const pending = await listScheduledPosts(row.page_id, token, 100);
        pendingByPage.set(row.page_row_id, new Set(pending.map((p) => String(p.id))));
      }
      const pendingIds = pendingByPage.get(row.page_row_id);
      const stillPending = [...pendingIds].some((id) =>
        id === String(row.fb_post_id) || id.endsWith(`_${row.fb_post_id}`) || String(row.fb_post_id).endsWith(`_${id}`)
      );
      const publishUnix =
        Math.floor(Date.parse(row.scheduled_publish_time || "") / 1000) || null;
      // Đã qua giờ hẹn ≥ 2 phút: nếu FB vẫn kẹt unpublished / hidden / scheduled_posts
      // → ép publish public (glitch Graph hay gặp với video hẹn giờ).
      const pastGrace =
        publishUnix != null && Date.now() / 1000 >= publishUnix + 120;

      if (stillPending && pastGrace) {
        try {
          await forcePublishScheduledObject(row.fb_post_id, token, publishUnix);
          pendingIds.delete(String(row.fb_post_id));
        } catch (forceErr) {
          db.prepare(
            `UPDATE post_logs SET status = 'schedule_overdue', error = ? WHERE id = ?`
          ).run(
            `Đã qua giờ nhưng vẫn trong scheduled_posts — ép publish fail: ${forceErr.message || forceErr}`,
            row.id
          );
          results.push({
            id: row.id,
            page_name: row.page_name,
            status: "schedule_overdue",
            post_url: row.fb_post_url,
            force_publish_error: forceErr.message || String(forceErr),
          });
          await sleep(250);
          continue;
        }
      } else if (stillPending) {
        db.prepare(
          `UPDATE post_logs SET status = 'schedule_overdue', error = ? WHERE id = ?`
        ).run(
          "Đã qua giờ dự kiến nhưng bài vẫn còn trong scheduled_posts của Facebook",
          row.id
        );
        results.push({
          id: row.id,
          page_name: row.page_name,
          status: "schedule_overdue",
          post_url: row.fb_post_url,
        });
        await sleep(250);
        continue;
      }

      let fb = await getFacebookPostStatus(row.fb_post_id, token);
      let forceNote = null;
      // Kẹt admin-only: is_published=false hoặc is_hidden=true sau giờ hẹn
      const stuckUnpublished =
        pastGrace &&
        (fb.is_published === false ||
          fb.is_hidden === true ||
          (fb.scheduled_publish_time != null &&
            Number(fb.scheduled_publish_time) * 1000 < Date.now() - 120_000));
      if (stuckUnpublished) {
        try {
          await forcePublishScheduledObject(row.fb_post_id, token, publishUnix);
          forceNote = "force_publish_ok";
          await sleep(500);
          fb = await getFacebookPostStatus(row.fb_post_id, token);
        } catch (forceErr) {
          forceNote = `force_publish_fail: ${forceErr.message || forceErr}`;
        }
      }

      const explicitPublished = fb.is_published === true;
      const explicitUnpublished = fb.is_published === false;
      const hidden = fb.is_hidden === true;
      const looksPublished =
        !!fb.permalink_url && !fb.scheduled_publish_time && !hidden;
      const objectExists = !!fb.id && !hidden;
      const status =
        (explicitPublished || (!explicitUnpublished && looksPublished) ||
          (forceNote === "force_publish_ok" && objectExists)) &&
        !hidden
          ? "published"
          : "schedule_overdue";
      const url = fb.permalink_url || row.fb_post_url || null;
      const errMsg =
        status === "schedule_overdue"
          ? forceNote && forceNote.startsWith("force_publish_fail")
            ? `Đã qua giờ — bài có thể chỉ admin thấy. ${forceNote}`
            : hidden
              ? "Đã qua giờ nhưng Facebook is_hidden=true (chỉ admin thấy) — mở Business Suite → Edit → Save hoặc bấm Đối soát lại"
              : "Đã qua giờ dự kiến nhưng Facebook vẫn báo chưa xuất bản / chưa public"
          : forceNote === "force_publish_ok"
            ? null
            : null;
      db.prepare(
        `UPDATE post_logs SET status = ?, fb_post_url = COALESCE(?, fb_post_url), error = ? WHERE id = ?`
      ).run(status, url, errMsg, row.id);

      let commentResult = null;
      if (status === "published") {
        // Small delay so Graph is ready for comments right after publish
        await sleep(400);
        commentResult = await applyPendingCommentForLog(
          { ...row, fb_post_url: url, scheduled_publish_time: row.scheduled_publish_time },
          token,
          fb
        );
        if (commentResult.commented && !commentResult.skipped) commentsOk++;
        if (commentResult.error && !commentResult.skipped && !commentResult.waiting) commentsFail++;
      }

      results.push({
        id: row.id,
        page_name: row.page_name,
        status,
        post_url: url,
        comment: commentResult
          ? {
              ok: !!commentResult.commented,
              comment_id: commentResult.comment_id || null,
              error: commentResult.error || null,
              skipped: !!commentResult.skipped,
              waiting: !!commentResult.waiting,
              reason: commentResult.reason || null,
              likes: commentResult.likes,
              delay_min: commentResult.delay_min,
              min_likes: commentResult.min_likes,
              ready_at: commentResult.ready_at || null,
            }
          : null,
      });
    } catch (e) {
      results.push({ id: row.id, page_name: row.page_name, status: "unknown", error: e.message });
    }
    await sleep(250);
  }

  // Second pass: ALL published posts still missing comment (not only first / transition).
  // Includes delay/likes wait — will retry every reconcile tick.
  const needComment = db.prepare(`
    SELECT l.id, l.page_row_id, l.page_id, l.page_name, l.fb_post_id, l.fb_post_url,
           l.comment_text, l.comment_id, l.scheduled_publish_time, p.page_token_enc
    FROM post_logs l
    JOIN fb_pages p ON p.id = l.page_row_id
    WHERE l.status = 'published'
      AND l.fb_post_id IS NOT NULL
      AND (l.comment_id IS NULL OR l.comment_id = '')
      AND (
        (l.comment_text IS NOT NULL AND l.comment_text != '' AND l.comment_text NOT LIKE '[comment failed]%')
        OR EXISTS (
          SELECT 1 FROM page_post_config c
          WHERE c.page_row_id = l.page_row_id AND c.comment_enabled = 1
        )
      )
    ORDER BY l.scheduled_publish_time ASC, l.id ASC
    LIMIT ?
  `).all(Math.min(80, Math.max(1, Number(limit) || 50)));

  let commentsWaiting = 0;
  for (const row of needComment) {
    // Skip if already handled in first pass this tick
    if (results.some((x) => x.id === row.id && x.comment)) continue;
    try {
      const token = decryptToken(row.page_token_enc);
      const cr = await applyPendingCommentForLog(row, token, null);
      if (cr.commented && !cr.skipped) commentsOk++;
      if (cr.error && !cr.skipped && !cr.waiting) commentsFail++;
      if (cr.waiting) commentsWaiting++;
      results.push({
        id: row.id,
        page_name: row.page_name,
        status: cr.waiting ? "published_awaiting_comment" : "published_comment_retry",
        comment: {
          ok: !!cr.commented,
          comment_id: cr.comment_id || null,
          error: cr.error || null,
          skipped: !!cr.skipped,
          waiting: !!cr.waiting,
          reason: cr.reason || null,
          likes: cr.likes,
          delay_min: cr.delay_min,
          min_likes: cr.min_likes,
          ready_at: cr.ready_at || null,
        },
      });
    } catch (e) {
      results.push({
        id: row.id,
        page_name: row.page_name,
        status: "published_comment_retry",
        error: e.message,
      });
    }
    await sleep(300);
  }

  return {
    checked: rows.length,
    published: results.filter((r) => r.status === "published").length,
    overdue: results.filter((r) => r.status === "schedule_overdue").length,
    unknown: results.filter((r) => r.status === "unknown").length,
    comments_ok: commentsOk,
    comments_fail: commentsFail,
    comments_waiting: commentsWaiting,
    results,
  };
}
