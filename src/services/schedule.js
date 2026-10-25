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
  COMMENT_PREVIEW_FALLBACK_NOTE,
  listScheduledPosts,
  getFacebookPostStatus,
  extractPostLikeCount,
  validateScheduleUnix,
  forcePublishScheduledObject,
  absoluteFacebookUrl,
  pageVideoUrl,
  pageStoryUrl,
  preferRealPostUrl,
  isPagePostId,
  resolveReelCommentPost,
} from "./publish.js";
import { applyRunMedia } from "./tokenMedia.js";
import path from "path";
import {
  pickCaption,
  captionModeForRun,
  getCommentPickMode,
  buildComment,
  assignCommentForPost,
  ensureCommentHasLink,
  composeCaptionWithLead,
  assertMatchedBundle,
} from "./mediaLibrary.js";
import { pickNextVideoTitle } from "./videoTitlePool.js";
import {
  getCaptionStats,
  getPagePostConfig,
  noteBundlePosted,
  savePagePostConfig,
  wantsCaption,
  assertCaptionIfEnabled,
  composePlannedComment,
} from "./poster.js";
import { formatFbNotice } from "./fbNotice.js";
import { commentDueIso, parseDbTime, readCommentTiming } from "./commentTiming.js";
import { applyMentionsToText } from "./mentions.js";
import { resolveGroupToPageIds } from "./selectionGroups.js";
import {
  getActiveTimesForPageRow,
  buildSlotsFromActiveHours,
  buildSlotsFromWindows,
  parseFixedTimes,
} from "./activeTimes.js";
import { lockScheduleTiming } from "./scheduleTimingLock.js";
import { appendPostCsv } from "./postLogCsv.js";

/** Theo bộ only. Slot sớm hơn now+10 phút thì cộng nguyên ngày, giữ đúng HH:mm. */
export function rollPastSlots(slots, nowMs = Date.now()) {
  const minOk = nowMs + 10 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;
  const rolled = (slots || []).map((d) => {
    let t = d instanceof Date ? d.getTime() : new Date(d).getTime();
    let guard = 0;
    while (Number.isFinite(t) && t < minOk && guard < 30) {
      t += dayMs;
      guard += 1;
    }
    return new Date(t);
  });
  rolled.sort((a, b) => a.getTime() - b.getTime());
  return rolled;
}
import {
  assertCanPublish,
  pickUnusedMedia,
  finalizeMediaAfterSuccess,
  noteGraphFailure,
  enforceBulkLimits,
  ensureAntiSpamTables,
  getAntiSpamSettings,
  isPageCircuitOpen,
  openPageCircuit,
  countUnusedMedia,
  inspectMediaFolder,
} from "./antiSpam.js";
import {
  getGlobalGraphPauseRemainingMs,
  isCommunitySpamBlock,
  isGraphRateLimitError,
  isSpamBlockError,
  isPermissionError,
  noteGlobalRateLimit,
} from "./rateLimit.js";
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
 * Kiểm tra đủ media cho toàn bộ slot kế hoạch.
 * - once: cộng dồn required theo folder|kind (mỗi slot 1 file)
 * - all_pages: chỉ cần N file theo số slot/page (cùng bộ mọi page), đếm theo total trên đĩa
 */
function assessMediaForPlan(finalPlan, { postType, bodyPostType, mediaReuse, skipHash } = {}) {
  const force = postType || (bodyPostType && bodyPostType !== "auto" ? bodyPostType : null);
  const reuseAll =
    String(mediaReuse || "").toLowerCase() === "all_pages" ||
    mediaReuse === true ||
    mediaReuse === 1;
  const mediaNeeds = new Map(); // key folder|kind
  /** @type {Map<string, Set<number>>} */
  const roundSets = new Map(); // folder|kind → set of slot index within page
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
          reuse_all_pages: reuseAll,
        });
        roundSets.set(key, new Set());
      }
      const need = mediaNeeds.get(key);
      if (reuseAll) {
        // Cùng index slot trên mỗi page = cùng file trong bộ shared
        roundSets.get(key).add(i);
      } else {
        need.required += 1;
      }
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

  if (reuseAll) {
    for (const [key, rounds] of roundSets.entries()) {
      const need = mediaNeeds.get(key);
      if (need) need.required = rounds.size;
    }
  }

  const pools = [];
  const shortfalls = [];
  const messages = [];

  for (const need of mediaNeeds.values()) {
    let inv = {
      total: 0,
      unused: 0,
      used: 0,
      protect_used: false,
      media_once_forever: false,
    };
    if (!need.folder) {
      inv = { total: 0, unused: 0, used: 0, protect_used: false };
    } else {
      try {
        inv = inspectMediaFolder(need.folder, need.kind, { skipHash: !!skipHash });
      } catch {
        inv = { total: 0, unused: 0, used: 0, protect_used: false };
      }
    }
    // all_pages: tái dùng file / giữ kho → đếm total trên đĩa, bỏ qua hash đã dùng
    const available = reuseAll ? Number(inv.total) || 0 : Number(inv.unused) || 0;
    need.available = available;
    need.total_on_disk = Number(inv.total) || 0;
    need.used_hashes = Number(inv.used) || 0;
    need.ok = available >= need.required;
    need.short = Math.max(0, need.required - available);
    pools.push({ ...need });
    if (!need.ok) {
      shortfalls.push({ ...need });
      const kindLabel = need.kind === "video" ? "video" : "ảnh";
      const pageHint = need.page_names.length
        ? ` (page: ${need.page_names.slice(0, 5).join(", ")}${need.page_names.length > 5 ? "…" : ""})`
        : "";
      if (!need.folder) {
        messages.push(
          `Thiếu folder media cho ${need.page_names.slice(0, 4).join(", ")}` +
            `${need.page_names.length > 4 ? "…" : ""} — cần ${need.required} ${kindLabel}`
        );
      } else if (reuseAll) {
        messages.push(
          `Mode cùng bộ media: cần ${need.required} ${kindLabel} (theo số bài/page), kho có ${inv.total} trong ${need.folder}` +
            pageHint
        );
      } else if (inv.total > 0 && inv.used > 0 && available < need.required) {
        // Còn file trong kho nhưng trùng nội dung đã chuyển sang posted (hash thật)
        messages.push(
          `Mode «Random chưa đăng»: cần ${need.required} ${kindLabel} trong kho media, ` +
            `kho có ${inv.total} file nhưng ${inv.used} trùng nội dung đã có ở folder posted` +
            ` (chỉ còn ${available} dùng được). Folder: ${need.folder}. ` +
            `Cách xử lý: (1) xóa/chuyển các bản trùng sang posted, (2) thêm file mới, ` +
            `(3) Anti-spam → Xóa hash media, hoặc (4) chọn «Cùng bộ media cho mọi page».` +
            pageHint
        );
      } else {
        messages.push(
          `Thiếu ${kindLabel}: cần ${need.required}, còn ${available}/${inv.total || 0} trong ${need.folder}` +
            pageHint
        );
      }
    }
  }

  const ok = shortfalls.length === 0;
  return {
    ok,
    total_slots: totalSlots,
    media_slots: mediaSlots,
    media_reuse: reuseAll ? "all_pages" : "once",
    pools,
    shortfalls,
    messages,
    pages: pageNotes,
    // Không nhét messages[0] vào summary — UI đã liệt kê từng dòng (tránh báo trùng)
    summary: ok
      ? reuseAll
        ? `Đủ media (cùng bộ): cần ${pools.map((p) => `${p.required} ${p.kind}`).join(", ") || "0"} · mọi page dùng chung · ${totalSlots} slot.`
        : totalSlots
          ? `Đủ media cho ${mediaSlots} slot cần ảnh/video (${totalSlots} slot tổng).`
          : "Không có slot để kiểm tra media."
      : `THIẾU media — ${shortfalls.length} kho không đủ` +
        (reuseAll ? " (mode cùng bộ)." : " (mode random chưa đăng — chỉ đếm file chưa dùng)."),
  };
}

function logScheduled(row) {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO post_logs (
        page_row_id, page_id, page_name, post_type, media_path, caption,
        fb_post_id, fb_post_url, day_index, status, error, comment_text, comment_id,
        scheduled_publish_time, comment_due_at
      ) VALUES (
        @page_row_id, @page_id, @page_name, @post_type, @media_path, @caption,
        @fb_post_id, @fb_post_url, @day_index, @status, @error, @comment_text, @comment_id,
        @scheduled_publish_time, @comment_due_at
      )`
    )
    .run({ ...row, comment_due_at: row.comment_due_at || null });
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
  if (opts.media_folder) cfg = { ...cfg, media_folder: opts.media_folder };
  if (opts.posted_folder) cfg = { ...cfg, posted_folder: opts.posted_folder };
  if (opts.captions_folder) cfg = { ...cfg, captions_folder: opts.captions_folder };
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
  const captionOn = wantsCaption(cfg, opts);
  const manualCaption0 = opts.caption != null && String(opts.caption).trim();
  const captionPoolTotal = getCaptionStats(cfg).total;
  const maxCaptionAttempts = Math.max(1, captionPoolTotal || 1);
  let selectedCaptionSlot = captionSlot;

  if (!captionOn && !manualCaption0 && (postType === "photo" || postType === "image" || postType === "video")) {
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
    usedPoolCaption = false;
    const gate = assertCanPublish({
      pageRowId,
      pageId: page.page_id,
      caption: "",
      mediaPath,
      ignore_quota: false,
      ignore_interval: false,
      isSchedule: true,
      scheduledAtUnix: unix,
      reuse_all_pages: opts.media_reuse === "all_pages",
      skip_time_caps: !!opts.match_bundle,
      skip_caption_dup: !!opts.match_bundle,
    });
    if (!gate.ok) throw new Error(gate.error || "Không hẹn được (anti-spam / quota)");
  } else {
    // Reserve caption slot ONCE before loop — retries use slot offset so DB
    // counter is not burned on every attempt (Bug #2 fix).
    const baseReservation = !manualCaption0
      ? reserveCaptionSlot({
          captionsFolder: cfg.captions_folder,
          captions: cfg.captions,
          pageRowId,
        })
      : { slot_index: captionSlot };
    selectedCaptionSlot = baseReservation.slot_index;
    const captionMode = captionModeForRun(cfg, opts);
    for (let attempt = 0; attempt < maxCaptionAttempts; attempt++) {
      const manualCaption = manualCaption0;
      if (
        !manualCaption &&
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
      }
      caption =
        manualCaption
          ? String(opts.caption).trim()
          : pickCaption(
              cfg.captions,
              selectedCaptionSlot + attempt,
              captionMode,
              cfg.captions_folder,
              triedCaptions,
              mediaPath || ""
            );
      if (caption && !manualCaption) triedCaptions.push(caption);
      usedPoolCaption = !manualCaption;
      const gate = assertCanPublish({
        pageRowId,
        pageId: page.page_id,
        caption,
        mediaPath: postType === "text" ? null : mediaPath,
        ignore_quota: false,
        ignore_interval: false,
        isSchedule: true,
        scheduledAtUnix: unix,
        skip_time_caps: !!opts.match_bundle,
        skip_caption_dup: !!opts.match_bundle,
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
      if (gate.code === "MEDIA_DUP" || gate.code === "MEDIA_RECENT") {
        mediaPath = null;
        continue;
      }
      if (
        !wantsCaption(cfg, opts) &&
        !manualCaption &&
        captionMode === "match_media" &&
        gate.code === "CAPTION_DUP"
      ) {
        caption = "";
        usedPoolCaption = false;
        break;
      }
      if (manualCaption || attempt === maxCaptionAttempts - 1 || !caption) {
        if (
          !wantsCaption(cfg, opts) &&
          !manualCaption &&
          (postType === "photo" || postType === "image" || postType === "video") &&
          (gate.code === "CAPTION_DUP" || !caption)
        ) {
          caption = "";
          usedPoolCaption = false;
          break;
        }
        if (gate.code === "CAPTION_DUP" || triedCaptions.length) {
          throw new Error(
            `Hết caption khả dụng trong kho (đã dùng / trùng trong cửa sổ anti-spam). ` +
              `Đã thử ${triedCaptions.length}/${captionPoolTotal || 0} caption. Thêm dòng vào kho Caption (.txt/.csv) hoặc tắt «Dùng caption».` +
              (gate.error ? ` — ${gate.error}` : "")
          );
        }
        throw new Error(gate.error || "Không chọn được caption để hẹn giờ");
      }
      mediaPath = null;
    }
  }

  if (opts.match_bundle && postType !== "text") {
    assertMatchedBundle({ mediaPath, caption, cfg });
  }

  // Mode theo bộ: caption là đúng dòng số trong file caption, không gắn mở đầu kiểu cũ
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
  caption = applyMentionsToText(caption, cfg, "caption");

  const pageToken = decryptToken(page.page_token_enc);
  const schedule = { scheduled_publish_time: unix };
  let movedPath = null;
  let result = null;
  let fin = { movedPath: null, hash: null };

  let plannedComment = null;
  try {
    assertCaptionIfEnabled(cfg, opts, caption, postType);
    if (Number(schedule.scheduled_publish_time) !== Number(unix)) {
      throw new Error(
        `Kiểm tra cấu hình: giờ định gửi ${schedule.scheduled_publish_time} khác giờ đã chọn ${unix}. Chưa gửi Facebook.`
      );
    }
    plannedComment = composePlannedComment({ cfg, opts, pageRowId, mediaPath });
    if (postType === "text") {
      if (!caption) {
        throw new Error(
          "Hẹn text cần caption trong kho .txt/.csv hoặc inline — không bịa nội dung"
        );
      }
      result = await publishText(page.page_id, pageToken, caption, schedule);
    } else if (postType === "photo" || postType === "image") {
      if (!mediaPath) {
        throw new Error(
          `Không có ảnh chưa dùng trong: ${cfg.media_folder || "(trống)"} — không hẹn bài text thay thế.`
        );
      }
      result = await publishPhoto(
        page.page_id,
        pageToken,
        mediaPath,
        caption || "",
        schedule
      );
    } else if (postType === "video") {
      if (!mediaPath) {
        throw new Error(`Không có video chưa dùng: ${cfg.media_folder || "(trống)"}`);
      }
      // Hẹn giờ video = POST /video_reels, video_state=SCHEDULED, tối đa 29 ngày.
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
    } else if (String(postType).startsWith("story")) {
      throw new Error(
        "Story không hẹn giờ Facebook được. Chọn Loại bài = story rồi bấm Đăng ngay API."
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
        keep_in_inbox: opts.media_reuse === "all_pages",
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

    // Bài hẹn chưa public. Không gọi API comment lúc Facebook nhận lịch.
    // Giữ câu, gửi sau giờ publish + số phút. Tool phải đang mở.
    let pendingComment = plannedComment?.text || null;
    let commentLinkLists = plannedComment?.link_lists || cfg.link_lists;
    const commentTiming = readCommentTiming(commentLinkLists);
    const commentWhen = pendingComment ? "after_publish" : commentTiming.when;
    const commentDelayMin = commentTiming.afterPublish ? commentTiming.delayMin : 0;

    // Do NOT write future scheduled time into last_post_at (would block Direct Local forever).
    // Quota/interval for Direct Local read post_logs (scheduled + direct) via schedulePolicy.
    savePagePostConfig(pageRowId, {
      ...cfg,
      link_lists: commentLinkLists,
      next_slot_index: slot + 1,
      caption_slot_index: usedPoolCaption && caption ? selectedCaptionSlot + 1 : captionSlot,
    });
    if (postType !== "text") noteBundlePosted(opts, cfg, mediaPath, result?.post_id);

    const scheduledIso = new Date(unix * 1000).toISOString();
    const commentDueAt = pendingComment ? commentDueIso(unix * 1000, commentDelayMin) : null;
    const logError = null;
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
      error: logError,
      // Nếu comment ngay OK → đã có comment_id; không thì pending đến lúc publish
      comment_text: pendingComment || null,
      comment_id: null,
      scheduled_publish_time: scheduledIso,
      comment_due_at: commentDueAt,
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
      comment_pending: Boolean(pendingComment),
      comment_immediate: false,
      comment_when: commentWhen,
      comment_delay_minutes: commentDelayMin,
      comment_min_likes: commentTiming.afterPublish ? commentTiming.minLikes : 0,
      comment_ready_at: commentDueAt,
      comment_id: null,
      comment_error: null,
      comment_preview_fallback: false,
      comment_preview_note: null,
      caption_sent: !!String(caption || "").trim(),
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
      /caption|media|inbox|kho|quota|interval|cooldown|anti-spam|hết caption|không có ảnh|không có video|Kiểm tra cấu hình/i.test(
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
/**
 * Mode ② Start at: đúng số phút user gõ, kể cả 0.
 * strictTiming tắt thì không thấp hơn min-gap page. Cửa sổ Facebook ≥ 10 phút
 * kể từ lúc bấm được lọc ở bước sau, không cộng thêm vào khoảng cách bài.
 */
export function resolveStartAtInterval({
  rawMin,
  rawMax,
  strictTiming = true,
  minGap = 0,
  fallback = 120,
} = {}) {
  const fb = Number(fallback);
  const base =
    Number.isFinite(Number(rawMin)) && Number(rawMin) >= 0
      ? Number(rawMin)
      : Number.isFinite(fb) && fb >= 0
        ? fb
        : 0;
  let intervalMin = base;
  let intervalMax = Math.max(
    intervalMin,
    Number.isFinite(Number(rawMax)) && Number(rawMax) >= 0 ? Number(rawMax) : intervalMin
  );
  if (!strictTiming) {
    const floor = Math.max(0, Number(minGap) || 0);
    intervalMin = Math.max(floor, intervalMin);
    intervalMax = Math.max(intervalMin, intervalMax);
  }
  return { intervalMin, intervalMax };
}

/**
 * Mode ③ và Theo bộ giờ tích cực.
 * Anti tắt, hoặc Theo bộ: đúng cooldown user gõ, jitter 0.
 * Anti bật trên hẹn giờ thường: không thấp hơn gap policy và vẫn jitter.
 */
export function resolveActiveTimeSpacing({
  intervalMin,
  intervalMax,
  antiOn = false,
  matchBundle = false,
  policyMinGap = 0,
  antiJitterMin = 5,
} = {}) {
  const cdMin = Number(intervalMin);
  const cdMax = Number(intervalMax);
  const userMin = Number.isFinite(cdMin) ? Math.max(0, cdMin) : null;
  const userMax = Number.isFinite(cdMax) ? Math.max(0, cdMax) : null;
  const policy = Math.max(0, Number(policyMinGap) || 0);
  const applyPolicy = !!antiOn && !matchBundle;
  const gapFloor =
    userMin == null ? policy : Math.max(applyPolicy ? policy : 0, userMin);
  const gapCeil = userMax == null ? gapFloor : Math.max(gapFloor, userMax);
  const jitterMinutes = applyPolicy ? Math.max(5, Number(antiJitterMin) || 5) : 0;
  return { gapFloor, gapCeil, jitterMinutes };
}

export async function scheduleBulk(body = {}) {
  const pageIds = [
    ...new Set(
      (Array.isArray(body.page_row_ids) ? body.page_row_ids : [])
        .map(Number)
        .filter((n) => n > 0)
    ),
  ];
  if (!pageIds.length) {
    throw new Error("Chọn ít nhất 1 page đã tick (page_row_ids) — không chạy page ngoài danh sách");
  }
  applyRunMedia(pageIds, body.account_group_ids);

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
  const timingLock = lockScheduleTiming(body);
  const requestedPerDay = timingLock.postsPerDay;

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
      if (timingLock.times.length) {
        // List thời điểm = mốc gốc (HH:mm hoặc đủ ngày). Page 0 = đúng giờ.
        // Page N = giờ + pageStagger. Khoảng giữa các dòng list giữ nguyên.
        slots = parseFixedTimes(timingLock.times, tz).map(
          (d) => new Date(d.getTime() + pageStagger * 60 * 1000)
        );
        const cdMin = Math.max(0, Number(body.list_cooldown_min) || 0);
        const cdMax = Math.max(cdMin, Number(body.list_cooldown_max) || 0);
        if (cdMin > 0 && slots.length > 1) {
          const rng = makeSeededRng(`${pageRowId}.list.${cdMin}.${cdMax}`);
          for (let i = 1; i < slots.length; i++) {
            const gapMin = cdMax > cdMin ? cdMin + Math.floor(rng() * (cdMax - cdMin + 1)) : cdMin;
            const earliest = slots[i - 1].getTime() + gapMin * 60 * 1000;
            if (slots[i].getTime() < earliest) slots[i] = new Date(earliest);
          }
        }
      } else if (timingLock.startAt) {
        // count_per_page = bài / page / ngày; nhân với days_ahead (hẹn nhiều ngày)
        const rawCount = Math.min(200, Math.max(1, Number(body.count_per_page) || 1));
        const countPerDay = ignorePageCap
          ? rawCount
          : Math.min(rawCount, policy.max_posts_per_day_effective);
        // strictTiming: đúng phút user gõ, kể cả 0. Không ép sàn 10 hay 120.
        // Khoảng cách bài–bài CÙNG page: interval_minutes_min/max
        const rawMin = Number(body.interval_minutes_min);
        const rawMax = Number(body.interval_minutes_max);
        const fallbackInterval =
          Number.isFinite(Number(body.interval_minutes)) && Number(body.interval_minutes) >= 0
            ? Number(body.interval_minutes)
            : Number.isFinite(Number(policy.interval_minutes))
              ? Number(policy.interval_minutes)
              : 120;
        const spaced = resolveStartAtInterval({
          rawMin,
          rawMax,
          strictTiming,
          minGap,
          fallback: fallbackInterval,
        });
        let intervalMin = spaced.intervalMin;
        let intervalMax = spaced.intervalMax;
        const randomizeInterval = intervalMax > intervalMin;
        const rng = makeSeededRng(
          `${pageRowId}.${timingLock.startAt}.${countPerDay}.${daysAhead}.${intervalMin}.${intervalMax}`
        );
        const startList = parseFixedTimes([timingLock.startAt], tz);
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
        timing_source: timingLock.times.length ? "list_times" : "start_at_interval",
        list_times: timingLock.times.length,
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

      const spacing = resolveActiveTimeSpacing({
        intervalMin: body.interval_minutes_min,
        intervalMax: body.interval_minutes_max,
        antiOn,
        matchBundle: !!body.match_bundle,
        policyMinGap: policy.min_gap_minutes,
        antiJitterMin: antiGlobal.jitter_minutes_min,
      });
      const minGap = spacing.gapFloor;
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
        startDay: body.active_start_day || null,
        startTime: body.active_start_time || null,
        jitterMinutes: spacing.jitterMinutes,
        pageStaggerMinutes: pageStagger,
      });
      if (spacing.gapCeil > minGap && slots.length > 1) {
        const rng = makeSeededRng(
          `${pageRowId}.active.${minGap}.${spacing.gapCeil}.${daysAhead}`
        );
        const spread = [slots[0]];
        for (let i = 1; i < slots.length; i++) {
          const extra = Math.floor(rng() * (spacing.gapCeil - minGap + 1));
          const earliest = spread[spread.length - 1].getTime() + (minGap + extra) * 60 * 1000;
          let t = slots[i].getTime();
          if (t < earliest) t = earliest;
          spread.push(new Date(t));
        }
        slots = spread;
      }
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

    // Theo bộ: mốc đã qua thì cộng từng ngày, giữ đúng phút cách nhau. Không đụng hẹn giờ hàng loạt.
    if (body.roll_past_slots && slots.length) {
      slots = rollPastSlots(slots);
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
  // honor_page_selection: page user tick không bị cắt im lặng bởi bulk_max_pages
  // Theo bộ tự giãn giờ và giữ đủ page đã tick. Không cắt bulk_max_total như hẹn giờ hàng loạt.
  const limited = body.roll_past_slots || body.match_bundle
    ? { plan, trimmed: false, caps: null, dropped_pages: [] }
    : enforceBulkLimits(plan, {
        ...body,
        strict_timing: strictTiming,
        honor_page_selection: true,
      });
  const finalPlan = limited.plan;

  const pagesWithSlots = finalPlan.filter((p) => (p.slots || []).length > 0);
  const pagesMissing = finalPlan.filter(
    (p) => !(p.slots || []).length || p.error
  );
  const coverage = {
    pages_requested: pageIds.length,
    pages_planned: pagesWithSlots.length,
    pages_missing: pagesMissing.length,
    pages_missing_list: pagesMissing.slice(0, 40).map((p) => ({
      page_row_id: p.page_row_id,
      page_name: p.page_name,
      error: p.error || "không có slot hợp lệ",
    })),
    dropped_by_anti_spam: limited.dropped_pages || [],
  };

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
    mediaReuse: body.media_reuse || body.mediaReuse,
    // Không sha256 cả folder lúc bấm Hẹn giờ — việc đó treo UI và dễ quét nhầm file chưa dùng.
    skipHash: true,
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
      ...coverage,
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
      plan: finalPlan.map((p) => {
        const all = p.slots || [];
        return {
          page_row_id: p.page_row_id,
          page_name: p.page_name,
          error: p.error || null,
          active: p.active || null,
          policy: p.policy || null,
          page_stagger_minutes: p.page_stagger_minutes || 0,
          slots_total: all.length,
          slots: all.map((d) => ({
            iso: d.toISOString(),
            unix: Math.floor(d.getTime() / 1000),
            local_label: formatLocal(d, tz),
          })),
        };
      }),
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
      await sleep(antiOn ? 150 : 80);
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
    ...coverage,
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
  const rules = readCommentTiming(cfg?.link_lists || {});
  return {
    delayMin: rules.delayMin,
    minLikes: rules.minLikes,
    afterPublish: rules.afterPublish,
  };
}

/**
 * True when enough time passed after scheduled publish + optional like threshold.
 * @returns {{ ready: boolean, reason?: string, likes?: number, delay_min?: number, min_likes?: number, ready_at?: string }}
 */
function evaluateCommentReady(row, cfg, fbStatus = null) {
  const rules = getCommentWaitRules(cfg);
  const { delayMin, minLikes } = rules;
  const storedDue = parseDbTime(row.comment_due_at);
  let readyAtMs = Number.isFinite(storedDue) ? storedDue : 0;
  if (!readyAtMs) {
    const scheduled = !!String(row.scheduled_publish_time || "").trim();
    const publishMs =
      parseDbTime(row.scheduled_publish_time) || parseDbTime(row.created_at) || 0;
    if (publishMs && (scheduled || delayMin > 0 || rules.afterPublish)) {
      const minutes = scheduled && !rules.afterPublish ? 0 : delayMin;
      readyAtMs = Date.parse(commentDueIso(publishMs, minutes) || "") || 0;
    }
  }
  if (readyAtMs && Date.now() < readyAtMs) {
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
async function applyPendingCommentForLog(row, token, fbStatus = null, opts = {}) {
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

  // Đăng trực tiếp (status ok) không chờ phút / chờ like của radio hẹn giờ.
  let gate = { ready: true, delay_min: 0, min_likes: 0 };
  if (!opts.ignoreScheduleWait) {
    const { minLikes } = getCommentWaitRules(cfg);
    let fb = fbStatus;
    if (minLikes > 0 && row.fb_post_id) {
      try {
        fb = await getFacebookPostStatus(row.fb_post_id, token);
      } catch {
        /* use existing */
      }
    }
    gate = evaluateCommentReady(row, cfg, fb);
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
  }

  let message = row.comment_text && String(row.comment_text).trim() ? String(row.comment_text).trim() : null;
  if (!message) {
    // No pre-assigned text (old rows / enabled later): assign now (advances sequential cursor)
    if (!cfg.comment_enabled) {
      return { commented: false, skipped: true, reason: "comment_disabled" };
    }
    // Không suy Theo bộ từ comment_link_mode còn lưu trên page.
    // Bài Theo bộ đã ghi sẵn comment_text lúc hẹn. Thiếu chữ thì gán kiểu đăng thường.
    const assigned = assignCommentForPost({
      ...cfg,
      comment_style: "classic",
      link_lists: cfg.link_lists,
      page_row_id: row.page_row_id,
      media_path: row.media_path || null,
      media_name: row.media_path ? path.basename(String(row.media_path)) : null,
      comment_site_tracker: null,
    });
    message = ensureCommentHasLink(assigned.text, assigned.link_lists || cfg.link_lists, { force: true });
    if (assigned.link_lists) {
      savePagePostConfig(row.page_row_id, { ...cfg, link_lists: assigned.link_lists });
    }
    if (message) {
      message = applyMentionsToText(
        message,
        { ...cfg, link_lists: assigned.link_lists || cfg.link_lists },
        "comment"
      );
    }
  }
  if (message && !/https?:\/\//i.test(message)) {
    const mode = getCommentPickMode(cfg.link_lists || {}, "random");
    const withLinkOff =
      cfg.link_lists?.comment_with_link === 0 ||
      cfg.link_lists?.comment_with_link === false ||
      cfg.link_lists?.comment_with_link === "0";
    const merged =
      String(cfg.link_lists?.comment_bundle_mode || "").trim().toLowerCase() === "merged";
    // Câu Theo bộ đã chốt lúc hẹn. Không gắn thêm link random khi bài lên tường.
    if (!(withLinkOff || merged || mode === "match_media")) {
      message = ensureCommentHasLink(message, cfg.link_lists || {}, { force: true });
    }
  }
  if (!message || !row.fb_post_id) {
    return { commented: false, skipped: true, reason: "no_message_or_post" };
  }

  const commentGate = isPageCircuitOpen(row.page_row_id, "comment");
  const authGate = isPageCircuitOpen(row.page_row_id, "auth");
  const heldGate = commentGate.open ? commentGate : authGate;
  if (heldGate.open) {
    return {
      commented: false,
      skipped: true,
      waiting: true,
      reason: "circuit",
      error: `Comment đang khóa. Còn ${heldGate.seconds_left}s. ${heldGate.reason || ""}`.trim(),
      ready_at: new Date(Number(heldGate.until_ts || 0) * 1000).toISOString(),
    };
  }

  let targetId = String(row.fb_post_id || "").trim();
  if (targetId && !isPagePostId(targetId)) {
    try {
      const resolved = await resolveReelCommentPost(targetId, token, row.page_id);
      if (resolved?.postId && resolved.postId !== targetId) {
        const url = pageStoryUrl(resolved.postId);
        db.prepare(
          `UPDATE post_logs SET fb_post_id = ?, fb_post_url = CASE
             WHEN ? IS NOT NULL AND ? != '' THEN ?
             ELSE fb_post_url
           END WHERE id = ?`
        ).run(resolved.postId, url, url, url, row.id);
        row.fb_post_id = resolved.postId;
        if (url) row.fb_post_url = url;
      }
      targetId = resolved?.postId || targetId;
    } catch (e) {
      if (isSpamBlockError(e) || isPermissionError(e)) {
        const code = Number(e?.code ?? e?.fb?.code ?? NaN);
        openPageCircuit(row.page_row_id, code === 190 ? "auth" : "comment", e.message || String(e));
        return {
          commented: false,
          skipped: true,
          waiting: true,
          reason: "circuit",
          error: e.message || String(e),
          err: e,
        };
      }
      return {
        commented: false,
        waiting: true,
        reason: "video_post",
        error: e.message || String(e),
        err: e,
      };
    }
  }

  try {
    const c = await publishComment(targetId, token, message);
    const previewNote = c.preview_fallback
      ? c.attachment_error || COMMENT_PREVIEW_FALLBACK_NOTE
      : null;
    db.prepare(
      `UPDATE post_logs SET comment_text = ?, comment_id = ?, error = CASE
         WHEN ? IS NOT NULL THEN ?
         ELSE error
       END WHERE id = ?`
    ).run(message, c.comment_id || null, previewNote, previewNote, row.id);
    return {
      commented: true,
      comment_id: c.comment_id || null,
      comment_text: message,
      preview_fallback: !!c.preview_fallback,
      likes: gate.likes,
      delay_min: gate.delay_min,
    };
  } catch (e) {
    // Nhịp tự gửi giữ nguyên câu + link để thử lại. Không đóng dấu fail vĩnh viễn.
    if (isSpamBlockError(e) || isPermissionError(e)) {
      const code = Number(e?.code ?? e?.fb?.code ?? NaN);
      openPageCircuit(row.page_row_id, code === 190 ? "auth" : "comment", e.message || String(e));
      return {
        commented: false,
        skipped: true,
        waiting: true,
        reason: "circuit",
        error: e.message || String(e),
        err: e,
      };
    }
    if (opts.keepTextOnFail) {
      return {
        commented: false,
        waiting: true,
        reason: "retry",
        error: e.message || String(e),
        err: e,
      };
    }
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

/** Reconcile overdue local scheduled logs against the Facebook object.
 * @param {{
 *   limit?: number,
 *   day?: string,
 *   account_id?: number,
 *   meta_app_key?: string,
 *   page_row_ids?: number[],
 *   log_ids?: number[],
 *   page_group_id?: string,
 *   account_group_id?: string,
 *   onProgress?: (p: object) => void
 * }} opts
 *   Chỉ đụng đúng phạm vi filter (ngày + TK/App/nhóm / đúng dòng đang hiện) — không quét cả hệ thống.
 */
export async function reconcileScheduledLogs({
  limit = 50,
  day = null,
  account_id = null,
  meta_app_key = null,
  page_row_ids = null,
  log_ids = null,
  page_group_id = null,
  account_group_id = null,
  onProgress = null,
} = {}) {
  const db = getDb();
  const dayVn =
    typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day.trim())
      ? day.trim()
      : null;
  const accountId = Number(account_id) > 0 ? Number(account_id) : null;
  const appKey = String(meta_app_key || "").trim() || null;
  const logIdSet =
    Array.isArray(log_ids) && log_ids.length
      ? new Set(log_ids.map(Number).filter((n) => n > 0))
      : null;
  let pageIdSet =
    Array.isArray(page_row_ids) && page_row_ids.length
      ? new Set(page_row_ids.map(Number).filter((n) => n > 0))
      : null;
  // Resolve nhóm page / nhóm TK → page_row_ids (cùng logic lịch)
  if (page_group_id || account_group_id) {
    try {
      const resolved = resolveGroupToPageIds({
        page_group_id: page_group_id || undefined,
        account_group_id: account_group_id || undefined,
      });
      const ids = (resolved?.page_row_ids || []).map(Number).filter((n) => n > 0);
      if (pageIdSet) {
        pageIdSet = new Set(ids.filter((id) => pageIdSet.has(id)));
      } else {
        pageIdSet = new Set(ids);
      }
    } catch (e) {
      console.warn("[reconcile] group resolve:", e.message);
      pageIdSet = new Set(); // fail closed — không đụng page ngoài nhóm
    }
  }

  // ISO có T/Z — không dùng julianday() (SQLite hay trả NULL). Lọc «đã tới giờ» bằng JS.
  const sql = `
    SELECT l.id, l.page_row_id, l.page_id, l.page_name, l.post_type, l.fb_post_id, l.fb_post_url,
           l.scheduled_publish_time, l.comment_text, l.comment_id, p.page_token_enc,
           p.account_id, COALESCE(a.meta_app_key,'app1') AS meta_app_key
    FROM post_logs l
    JOIN fb_pages p ON p.id = l.page_row_id
    LEFT JOIN fb_accounts a ON a.id = p.account_id
    WHERE l.status IN ('scheduled', 'schedule_overdue')
      AND l.fb_post_id IS NOT NULL
      ${dayVn ? "AND date(COALESCE(NULLIF(l.scheduled_publish_time,''), l.created_at), '+7 hours') = ?" : ""}
    ORDER BY l.scheduled_publish_time ASC
    LIMIT ?
  `;
  const lim = Math.min(500, Math.max(1, Number(limit) || 50) * 4);
  const rawRows = dayVn
    ? db.prepare(sql).all(dayVn, lim)
    : db.prepare(sql).all(lim);

  const nowMs = Date.now();
  const rows = rawRows
    .filter((r) => {
      const ms = Date.parse(r.scheduled_publish_time || "");
      if (!Number.isFinite(ms) || ms > nowMs) return false;
      if (logIdSet && !logIdSet.has(Number(r.id))) return false;
      if (accountId && Number(r.account_id) !== accountId) return false;
      if (appKey && String(r.meta_app_key || "app1") !== appKey) return false;
      if (pageIdSet && !pageIdSet.has(Number(r.page_row_id))) return false;
      return true;
    })
    .slice(0, Math.min(100, Math.max(1, Number(limit) || 50)));

  const results = [];
  const pendingByPage = new Map();
  let commentsOk = 0;
  let commentsFail = 0;
  const total = rows.length;
  const emitProgress = (i, extra = {}) => {
    try {
      onProgress?.({
        phase: "reconcile",
        current: i,
        total,
        percent: total ? Math.round((i / total) * 100) : 100,
        ...extra,
      });
    } catch {
      /* */
    }
  };
  if (!rows.length) {
    const empty_reason =
      "Không có bài đã tới giờ + có Facebook post id trong ngày/bộ lọc đang chọn. " +
      "Bài hiện «chưa đối soát» nhưng thiếu post id thì không hỏi Graph được (thường hẹn lỗi/thiếu id lúc đăng).";
    emitProgress(0, { percent: 100, message: empty_reason });
    return {
      checked: 0,
      published: 0,
      overdue: 0,
      still_on_fb: 0,
      unknown: 0,
      comments_ok: 0,
      comments_fail: 0,
      comments_waiting: 0,
      results: [],
      empty_reason,
    };
  }
  emitProgress(0, { message: `Bắt đầu đối soát ${total} bài…` });
  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
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
          const nowIso = new Date().toISOString();
          db.prepare(
            `UPDATE post_logs SET status = 'schedule_overdue', error = ?, last_reconciled_at = ? WHERE id = ?`
          ).run(
            `Đã qua giờ nhưng vẫn trong scheduled_posts — ép publish fail: ${forceErr.message || forceErr}`,
            nowIso,
            row.id
          );
          results.push({
            id: row.id,
            page_name: row.page_name,
            status: "schedule_overdue",
            post_url: row.fb_post_url,
            force_publish_error: forceErr.message || String(forceErr),
          });
          emitProgress(idx + 1, {
            page_name: row.page_name,
            status: "schedule_overdue",
            message: `${idx + 1}/${total} · ${row.page_name} · ép publish fail`,
          });
          await sleep(250);
          continue;
        }
      } else if (stillPending) {
        // Vẫn đúng trên FB (còn trong scheduled_posts) — giữ scheduled, không gắn «overdue»
        const nowIso = new Date().toISOString();
        db.prepare(
          `UPDATE post_logs SET status = 'scheduled', error = ?, last_reconciled_at = ? WHERE id = ?`
        ).run(
          pastGrace
            ? "Đã tới giờ — FB vẫn giữ trong scheduled_posts (chờ FB lên)"
            : null,
          nowIso,
          row.id
        );
        results.push({
          id: row.id,
          page_name: row.page_name,
          status: "still_scheduled_on_fb",
          post_url: row.fb_post_url,
        });
        emitProgress(idx + 1, {
          page_name: row.page_name,
          status: "still_scheduled_on_fb",
          message: `${idx + 1}/${total} · ${row.page_name} · vẫn trên lịch FB`,
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
      const built =
        row.post_type === "video"
          ? pageVideoUrl(row.page_id, row.fb_post_id)
          : pageStoryUrl(row.fb_post_id);
      const url =
        preferRealPostUrl(fb.permalink_url, row.fb_post_url) ||
        built ||
        absoluteFacebookUrl(fb.permalink_url || row.fb_post_url || null, row.fb_post_id || fb.id);
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
        `UPDATE post_logs SET status = ?, fb_post_url = COALESCE(?, fb_post_url), error = ?, last_reconciled_at = ? WHERE id = ?`
      ).run(status, url, errMsg, new Date().toISOString(), row.id);

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
      try {
        db.prepare(
          `UPDATE post_logs SET last_reconciled_at = ?, error = ? WHERE id = ?`
        ).run(new Date().toISOString(), String(e.message || e).slice(0, 300), row.id);
      } catch {
        /* */
      }
      results.push({
        id: row.id,
        page_name: row.page_name,
        status: "unknown",
        error: e.message,
      });
      emitProgress(idx + 1, {
        page_name: row.page_name,
        status: "unknown",
        message: `${idx + 1}/${total} · ${row.page_name} · lỗi: ${String(e.message || e).slice(0, 80)}`,
      });
    }
    if (results.length && results[results.length - 1]?.status === "published") {
      emitProgress(idx + 1, {
        page_name: row.page_name,
        status: "published",
        message: `${idx + 1}/${total} · ${row.page_name} · đã lên tường`,
      });
    } else if (
      results.length &&
      results[results.length - 1]?.status === "schedule_overdue"
    ) {
      emitProgress(idx + 1, {
        page_name: row.page_name,
        status: "schedule_overdue",
        message: `${idx + 1}/${total} · ${row.page_name} · chưa public`,
      });
    }
    await sleep(250);
  }

  // Second pass: published còn thiếu comment — cùng phạm vi ngày + TK/App/nhóm.
  const needCommentSql = `
    SELECT l.id, l.page_row_id, l.page_id, l.page_name, l.fb_post_id, l.fb_post_url,
           l.comment_text, l.comment_id, l.scheduled_publish_time, l.comment_due_at, l.created_at,
           p.page_token_enc,
           p.account_id, COALESCE(a.meta_app_key,'app1') AS meta_app_key
    FROM post_logs l
    JOIN fb_pages p ON p.id = l.page_row_id
    LEFT JOIN fb_accounts a ON a.id = p.account_id
    WHERE l.status = 'published'
      AND l.fb_post_id IS NOT NULL
      ${dayVn ? "AND date(COALESCE(NULLIF(l.scheduled_publish_time,''), l.created_at), '+7 hours') = ?" : ""}
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
  `;
  const needCommentLim = Math.min(80, Math.max(1, Number(limit) || 50));
  const needCommentRaw = dayVn
    ? db.prepare(needCommentSql).all(dayVn, needCommentLim * 3)
    : db.prepare(needCommentSql).all(needCommentLim * 3);
  const needComment = needCommentRaw
    .filter((r) => {
      if (accountId && Number(r.account_id) !== accountId) return false;
      if (appKey && String(r.meta_app_key || "app1") !== appKey) return false;
      if (pageIdSet && !pageIdSet.has(Number(r.page_row_id))) return false;
      return true;
    })
    .slice(0, needCommentLim);

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
    still_on_fb: results.filter((r) => r.status === "still_scheduled_on_fb")
      .length,
    unknown: results.filter((r) => r.status === "unknown").length,
    comments_ok: commentsOk,
    comments_fail: commentsFail,
    comments_waiting: commentsWaiting,
    results,
  };
}

/** Chờ giữa hai lần thử comment của cùng một dòng / cùng một token. Không ghi DB. */
const dueCommentRetryAt = new Map();

function commentRetryWait(err) {
  const msg = String(err?.fb?.message || err?.message || "");
  const code = Number(err?.code ?? err?.fb?.code ?? NaN);
  if (code === 1 || code === 2) return 3 * 60 * 1000;
  if (
    /unpublished|not published|isn.?t published|scheduled post|cannot comment|can.?t comment|comments can.?t|does not exist|doesn.?t exist|unknown error|unexpected error|please try again|temporarily|try again/i.test(
      msg
    )
  ) {
    return 3 * 60 * 1000;
  }
  return 15 * 60 * 1000;
}

/**
 * Gửi comment đã lưu (câu + link) cho bài hẹn đã qua giờ.
 * Không liệt kê lịch Facebook, không ép publish, không đổi status.
 * Mỗi token một comment mỗi nhịp, gửi lần lượt. Câu «thử lại sau» không phải page bị spam.
 */
export async function flushDueScheduledComments({ limit = 4 } = {}) {
  const db = getDb();
  const now = Date.now();
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
  const dueSlackMs = 24 * 60 * 60 * 1000;
  const graceMs = 20 * 1000;
  const cap = Math.min(4, Math.max(1, Number(limit) || 4));
  const oldestIso = new Date(now - maxAgeMs - dueSlackMs).toISOString();
  const newestIso = new Date(now - graceMs).toISOString();
  const raw = db
    .prepare(
      `SELECT l.id, l.status, l.page_row_id, l.page_id, l.post_type, l.page_name, l.fb_post_id, l.fb_post_url,
              l.comment_text, l.comment_id, l.scheduled_publish_time, l.comment_due_at, l.created_at,
              p.page_token_enc, p.account_id,
              COALESCE(a.meta_app_key, 'app1') AS meta_app_key
       FROM post_logs l
       JOIN fb_pages p ON p.id = l.page_row_id
       LEFT JOIN fb_accounts a ON a.id = p.account_id
       WHERE l.status IN ('scheduled', 'schedule_overdue', 'published', 'ok')
         AND l.fb_post_id IS NOT NULL AND TRIM(l.fb_post_id) != ''
         AND (l.comment_id IS NULL OR l.comment_id = '')
         AND l.comment_text IS NOT NULL AND TRIM(l.comment_text) != ''
         AND l.comment_text NOT LIKE '[comment failed]%'
         AND l.comment_text LIKE '%http%'
         AND (
           (
             l.status IN ('scheduled', 'schedule_overdue', 'published')
             AND l.scheduled_publish_time >= ?
             AND l.scheduled_publish_time <= ?
           )
           OR (
             l.status IN ('scheduled', 'schedule_overdue')
             AND l.scheduled_publish_time > ?
           )
           OR (
             l.status = 'ok'
             AND l.created_at >= datetime('now', CASE
               WHEN l.comment_due_at IS NOT NULL AND TRIM(l.comment_due_at) != '' THEN '-8 days'
               ELSE '-2 days'
             END)
           )
         )
       ORDER BY
         CASE
           WHEN l.scheduled_publish_time IS NULL OR l.scheduled_publish_time > ? THEN 1
           ELSE 0
         END,
         l.scheduled_publish_time ASC,
         l.id ASC
       LIMIT 500`
    )
    .all(oldestIso, newestIso, newestIso, newestIso);

  const cfgCache = new Map();
  const picked = [];
  const seenAccount = new Map();
  for (const row of raw) {
    if (picked.length >= cap) break;
    const direct = String(row.status) === "ok";
    const publishMs = Date.parse(row.scheduled_publish_time || "");
    if (!direct && !Number.isFinite(publishMs)) continue;
    const ageCap = Number.isFinite(parseDbTime(row.comment_due_at)) ? maxAgeMs + dueSlackMs : maxAgeMs;
    if (!direct && now - publishMs > ageCap) continue;
    if (dueCommentRetryAt.get(`row:${row.id}`) > now) continue;
    const accountKey = `acct:${row.account_id || `page-${row.page_row_id}`}`;
    if (dueCommentRetryAt.get(accountKey) > now) continue;
    if (getGlobalGraphPauseRemainingMs(row.meta_app_key || "app1") > 0) continue;
    const already = seenAccount.get(accountKey) || 0;
    if (already >= 1) continue;
    if (!cfgCache.has(row.page_row_id)) {
      cfgCache.set(row.page_row_id, getPagePostConfig(row.page_row_id));
    }
    const rules = getCommentWaitRules(cfgCache.get(row.page_row_id));
    const storedDue = parseDbTime(row.comment_due_at);
    if (Number.isFinite(storedDue) && now < storedDue) continue;
    if (!Number.isFinite(storedDue) && !direct && Number.isFinite(publishMs)) {
      const minutes = rules.afterPublish ? rules.delayMin || 0 : 0;
      const waitMs = Math.max(graceMs, minutes * 60 * 1000);
      if (now < publishMs + waitMs) continue;
    }
    if (!Number.isFinite(storedDue) && direct && rules.afterPublish) {
      const anchor = parseDbTime(row.created_at);
      const waitMs = Math.max(graceMs, (rules.delayMin || 0) * 60 * 1000);
      if (Number.isFinite(anchor) && now < anchor + waitMs) continue;
    }
    seenAccount.set(accountKey, already + 1);
    picked.push({ row, accountKey, direct, rules, storedDue });
  }

  let sent = 0;
  let failed = 0;
  const names = [];
  for (const { row, accountKey, direct, rules, storedDue } of picked) {
    try {
        const token = decryptToken(row.page_token_enc);
        const honorWait = Number.isFinite(storedDue) || !!rules?.afterPublish;
        const cr = await applyPendingCommentForLog(row, token, null, {
          keepTextOnFail: true,
          ignoreScheduleWait: direct && !honorWait,
        });
        if (cr.commented && cr.comment_id) {
          sent += 1;
          names.push(row.page_name || String(row.page_row_id));
          dueCommentRetryAt.delete(`row:${row.id}`);
          if (cr.preview_fallback) {
            console.warn(
              `[scheduler] comment mất thẻ preview: ${row.page_name || row.page_id} (#${row.id})`
            );
          }
          continue;
        }
        if (cr.commented) {
          dueCommentRetryAt.set(`row:${row.id}`, now + 3 * 60 * 1000);
          continue;
        }
        if (cr.waiting && cr.reason === "circuit") {
          const at = Date.parse(cr.ready_at || "") || now + 12 * 60 * 60 * 1000;
          dueCommentRetryAt.set(`row:${row.id}`, at);
          continue;
        }
        if (cr.waiting && cr.reason === "likes") {
          dueCommentRetryAt.set(`row:${row.id}`, now + 5 * 60 * 1000);
          continue;
        }
        if (cr.waiting && cr.reason === "delay") {
          const at = Date.parse(cr.ready_at || "") || now + 5 * 60 * 1000;
          dueCommentRetryAt.set(`row:${row.id}`, at);
          continue;
        }
        if (cr.waiting && cr.reason === "video_post") {
          dueCommentRetryAt.set(`row:${row.id}`, now + 45 * 1000);
          continue;
        }
        failed += 1;
        const err = cr.err || { message: cr.error || "" };
        if (isSpamBlockError(err) || isPermissionError(err) || isCommunitySpamBlock(err)) {
          const code = Number(err?.code ?? err?.fb?.code ?? NaN);
          openPageCircuit(row.page_row_id, code === 190 ? "auth" : "comment", err.message || cr.error || "");
          dueCommentRetryAt.set(`row:${row.id}`, now + 12 * 60 * 60 * 1000);
          continue;
        }
        if (isGraphRateLimitError(err)) {
          noteGlobalRateLimit(err, { metaAppKey: row.meta_app_key || "app1" });
          dueCommentRetryAt.set(accountKey, now + 20 * 60 * 1000);
          continue;
        }
        dueCommentRetryAt.set(`row:${row.id}`, now + commentRetryWait(err));
        console.warn(
          "[scheduler] comment link chưa gửi",
          row.page_name || row.page_row_id,
          String(cr.error || "").slice(0, 140)
        );
      } catch (e) {
        failed += 1;
        dueCommentRetryAt.set(`row:${row.id}`, now + 15 * 60 * 1000);
        console.warn(
          "[scheduler] comment link",
          row.page_name || row.page_row_id,
          String(e?.message || e).slice(0, 160)
        );
      }
    await sleep(4000);
  }

  return { sent, failed, names };
}
