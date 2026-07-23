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
  listScheduledPosts,
  getFacebookPostStatus,
  validateScheduleUnix,
} from "./publish.js";
import { pickCaption } from "./mediaLibrary.js";
import { getCaptionStats, getPagePostConfig, savePagePostConfig } from "./poster.js";
import {
  getActiveTimesForPageRow,
  buildSlotsFromActiveHours,
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
} from "./antiSpam.js";
import {
  resolvePagePostingPolicy,
  resolveMinGapMinutes,
  resolveMaxPostsPerDay,
  capSlotsByDailyQuota,
  todayYmd,
} from "./schedulePolicy.js";
import { assertCanPublish as assertLicenseActive } from "./license.js";
import { withPageOperationLock } from "./pageOperationLock.js";
import { reserveCaptionSlot } from "./captionPoolState.js";

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
  const cfg = getPagePostConfig(pageRowId);
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
  let selectedCaptionSlot = captionSlot;
  let usedPoolCaption = false;
  let mediaPath = null;
  const triedCaptions = [];
  const captionPoolTotal = getCaptionStats(cfg).total;
  const maxCaptionAttempts = Math.max(1, captionPoolTotal || 1);
  for (let attempt = 0; attempt < maxCaptionAttempts; attempt++) {
    const manualCaption = opts.caption != null && String(opts.caption).trim();
    if (!manualCaption) {
      selectedCaptionSlot = reserveCaptionSlot({
        captionsFolder: cfg.captions_folder,
        captions: cfg.captions,
        pageRowId,
      }).slot_index;
    }
    caption =
      manualCaption
        ? String(opts.caption).trim()
        : pickCaption(
            cfg.captions,
            selectedCaptionSlot,
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
      result = await publishVideo(
        page.page_id,
        pageToken,
        mediaPath,
        caption || "",
        schedule
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

    // Do NOT write future scheduled time into last_post_at (would block Direct Local forever).
    // Quota/interval for Direct Local read post_logs (scheduled + direct) via schedulePolicy.
    savePagePostConfig(pageRowId, {
      ...cfg,
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
      error: null,
      comment_text: null,
      comment_id: null,
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
      page: { id: page.id, page_id: page.page_id, name: page.name },
    };
  } catch (e) {
    noteGraphFailure(e);
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
 *  - count_per_page?: number
 *  - interval_minutes?: number
 *  - dry_run?: boolean — only return planned slots
 */
export async function scheduleBulk(body = {}) {
  const pageIds = Array.isArray(body.page_row_ids)
    ? body.page_row_ids.map(Number).filter((n) => n > 0)
    : [];
  if (!pageIds.length) {
    throw new Error("Chọn ít nhất 1 page (page_row_ids)");
  }

  const mode = body.mode === "fixed" ? "fixed" : "active_times";
  const tz = Number.isFinite(Number(body.tz_offset_minutes))
    ? Number(body.tz_offset_minutes)
    : 420;
  const postType =
    body.post_type && body.post_type !== "auto" ? body.post_type : null;
  const dryRun = !!body.dry_run;

  const plan = []; // { page_row_id, page_name, slots: Date[], active?, error? }
  const antiGlobal = getAntiSpamSettings();
  const antiOn = !!antiGlobal.enabled;
  // Stagger multi-page so many pages don't schedule the exact same second
  const staggerStep = antiOn
    ? Math.min(12, Math.max(3, Number(antiGlobal.jitter_minutes_min) || 3))
    : 5;
  let pageIndex = 0;
  const ignorePageCap = !!body.ignore_page_quota;
  const daysAhead = Math.min(30, Math.max(1, Number(body.days_ahead) || 3));
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
    const pageStagger = pageIndex * staggerStep;
    pageIndex += 1;

    // Shared policy: interval / max/day / preferred / remaining today
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

    if (mode === "fixed") {
      const cfg = getPagePostConfig(pageRowId);
      const minGap = resolveMinGapMinutes(cfg, antiGlobal);
      if (Array.isArray(body.times) && body.times.length) {
        slots = parseFixedTimes(body.times, tz).map(
          (d) => new Date(d.getTime() + pageStagger * 60 * 1000)
        );
      } else if (body.start_at) {
        // count_per_page capped by page max/day unless ignore
        const rawCount = Math.min(50, Math.max(1, Number(body.count_per_page) || 1));
        const count = ignorePageCap
          ? rawCount
          : Math.min(rawCount, policy.max_posts_per_day_effective);
        const interval = Math.max(
          minGap,
          Math.max(10, Number(body.interval_minutes) || policy.interval_minutes || 120)
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
        let t = startList[0].getTime() + pageStagger * 60 * 1000;
        for (let i = 0; i < count; i++) {
          slots.push(new Date(t));
          t += interval * 60 * 1000;
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
      // Enforce min gap between fixed slots
      if (minGap > 0 && slots.length > 1) {
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
        min_gap_minutes: minGap,
        page_stagger_minutes: pageStagger,
        anti_spam_enabled: antiOn,
      };
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
    slots = slots.filter(
      (d) =>
        d.getTime() >= now + 10 * 60 * 1000 &&
        d.getTime() <= now + 30 * 24 * 60 * 60 * 1000
    );

    // Cap by page daily quota (today = remaining after direct + already-scheduled)
    const capped = capSlotsByDailyQuota(slots, {
      maxPerDay: policy.max_posts_per_day_effective,
      remainingToday: policy.remaining_today,
      todayYmd: policy.today_ymd || todayYmd(tz),
      tzOffsetMinutes: tz,
    });
    slots = capped.slots;
    policyMeta = {
      ...policyMeta,
      quota_trimmed_slots: capped.trimmed,
      used_per_day_plan: capped.used_per_day,
    };

    plan.push({
      page_row_id: pageRowId,
      page_name: page.name,
      slots,
      active: activeMeta,
      policy: policyMeta,
      page_stagger_minutes: pageStagger,
      error: slots.length
        ? null
        : capped.trimmed
          ? `Hết quota ngày (max ${policy.max_posts_per_day_effective}/ngày, hôm nay còn ${policy.remaining_today}). Tăng max bài/ngày page hoặc bỏ tick hẹn trùng.`
          : "Không còn slot hợp lệ",
    });
  }

  // Anti-spam: hard bulk caps + jitter (skipped entirely when anti-spam OFF)
  const limited = enforceBulkLimits(plan, body);
  const finalPlan = limited.plan;

  if (dryRun) {
    return {
      dry_run: true,
      mode,
      tz_offset_minutes: tz,
      anti_spam_enabled: antiOn,
      anti_spam_trimmed: limited.trimmed,
      anti_spam_caps: limited.caps || null,
      page_stagger_step_minutes: staggerStep,
      policy_note:
        "Giờ / gap / max bài/ngày lấy từ cấu hình Page + anti-spam (khớp đăng trực tiếp). " +
        "Hôm nay trừ slot đã đăng + đã hẹn FB. Bật ignore_page_quota để bỏ cap page (không khuyến nghị).",
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
    tz_offset_minutes: tz,
    anti_spam_enabled: antiOn,
    anti_spam_trimmed: limited.trimmed,
    anti_spam_caps: limited.caps || null,
    page_stagger_step_minutes: staggerStep,
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

/** Reconcile overdue local scheduled logs against the Facebook object. */
export async function reconcileScheduledLogs({ limit = 50 } = {}) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT l.id, l.page_row_id, l.page_id, l.page_name, l.fb_post_id, l.fb_post_url,
           l.scheduled_publish_time, p.page_token_enc
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
      if (stillPending) {
        db.prepare(`UPDATE post_logs SET status = 'schedule_overdue', error = ? WHERE id = ?`)
          .run("Đã qua giờ dự kiến nhưng bài vẫn còn trong scheduled_posts của Facebook", row.id);
        results.push({ id: row.id, page_name: row.page_name, status: "schedule_overdue", post_url: row.fb_post_url });
        await sleep(250);
        continue;
      }
      const fb = await getFacebookPostStatus(row.fb_post_id, token);
      const explicitPublished = fb.is_published === true;
      const explicitUnpublished = fb.is_published === false;
      const looksPublished = !!fb.permalink_url && !fb.scheduled_publish_time;
      const objectExists = !!fb.id;
      const status = explicitPublished || (!explicitUnpublished && (looksPublished || objectExists))
        ? "published"
        : "schedule_overdue";
      const url = fb.permalink_url || row.fb_post_url || null;
      db.prepare(`UPDATE post_logs SET status = ?, fb_post_url = COALESCE(?, fb_post_url), error = ? WHERE id = ?`)
        .run(
          status,
          url,
          status === "schedule_overdue" ? "Đã qua giờ dự kiến nhưng Facebook vẫn báo chưa xuất bản" : null,
          row.id
        );
      results.push({ id: row.id, page_name: row.page_name, status, post_url: url });
    } catch (e) {
      results.push({ id: row.id, page_name: row.page_name, status: "unknown", error: e.message });
    }
    await sleep(250);
  }
  return {
    checked: rows.length,
    published: results.filter((r) => r.status === "published").length,
    overdue: results.filter((r) => r.status === "schedule_overdue").length,
    unknown: results.filter((r) => r.status === "unknown").length,
    results,
  };
}
