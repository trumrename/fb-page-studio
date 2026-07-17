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
  validateScheduleUnix,
} from "./publish.js";
import {
  pickMedia,
  moveToPosted,
  pickCaption,
  ensureDir,
} from "./mediaLibrary.js";
import { getPagePostConfig, savePagePostConfig } from "./poster.js";
import {
  getActiveTimesForPageRow,
  buildSlotsFromActiveHours,
  parseFixedTimes,
} from "./activeTimes.js";
import { appendPostCsv } from "./postLogCsv.js";

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
export async function scheduleOnePost(pageRowId, opts = {}) {
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
  const sequence =
    Array.isArray(cfg.sequence) && cfg.sequence.length
      ? cfg.sequence
      : ["photo", "text"];
  let postType = String(
    opts.post_type || opts.force_type || sequence[slot % sequence.length]
  ).toLowerCase();

  const caption =
    opts.caption != null && String(opts.caption).trim()
      ? String(opts.caption).trim()
      : pickCaption(cfg.captions, slot, cfg.pick_mode || "random", cfg.captions_folder);

  const pageToken = decryptToken(page.page_token_enc);
  const schedule = { scheduled_publish_time: unix };
  let mediaPath = null;
  let movedPath = null;
  let result = null;

  try {
    if (postType === "text") {
      if (!caption) {
        throw new Error(
          "Hẹn text cần caption trong kho .txt/.csv hoặc inline — không bịa nội dung"
        );
      }
      result = await publishText(page.page_id, pageToken, caption, schedule);
    } else if (postType === "photo" || postType === "image") {
      mediaPath = pickMedia(cfg.media_folder, "photo", cfg.pick_mode, slot);
      if (!mediaPath) {
        // fallback text if no photo
        if (caption && opts.allow_text_fallback !== false) {
          postType = "text";
          result = await publishText(page.page_id, pageToken, caption, schedule);
        } else {
          throw new Error(`Không có ảnh trong: ${cfg.media_folder || "(trống)"}`);
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
      mediaPath = pickMedia(cfg.media_folder, "video", cfg.pick_mode, slot);
      if (!mediaPath) {
        throw new Error(`Không có video trong: ${cfg.media_folder || "(trống)"}`);
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

    if (mediaPath && cfg.posted_folder) {
      ensureDir(cfg.posted_folder);
      movedPath = moveToPosted(mediaPath, cfg.posted_folder);
    }

    savePagePostConfig(pageRowId, {
      ...cfg,
      next_slot_index: slot + 1,
    });

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
      scheduled_publish_time: new Date(unix * 1000).toISOString(),
    });

    return {
      ok: true,
      scheduled: true,
      post_type: postType,
      scheduled_publish_time: unix,
      scheduled_at_iso: new Date(unix * 1000).toISOString(),
      post: result,
      log,
      media_moved_to: movedPath,
      page: { id: page.id, page_id: page.page_id, name: page.name },
    };
  } catch (e) {
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

    if (mode === "fixed") {
      if (Array.isArray(body.times) && body.times.length) {
        slots = parseFixedTimes(body.times, tz);
      } else if (body.start_at) {
        const count = Math.min(50, Math.max(1, Number(body.count_per_page) || 1));
        const interval = Math.max(10, Number(body.interval_minutes) || 120);
        const startList = parseFixedTimes([body.start_at], tz);
        if (!startList.length) {
          plan.push({
            page_row_id: pageRowId,
            page_name: page.name,
            slots: [],
            error: "start_at không parse được",
          });
          continue;
        }
        let t = startList[0].getTime();
        for (let i = 0; i < count; i++) {
          slots.push(new Date(t));
          t += interval * 60 * 1000;
        }
      } else {
        plan.push({
          page_row_id: pageRowId,
          page_name: page.name,
          slots: [],
          error: "mode fixed cần times[] hoặc start_at",
        });
        continue;
      }
    } else {
      // active_times
      const active = await getActiveTimesForPageRow(pageRowId, {
        force: !!body.force_active,
      });
      activeMeta = {
        ok: active.ok,
        top_hours: active.top_hours,
        peak_hour: active.peak_hour,
        metric: active.metric,
        error: active.error || null,
        cached: active.cached,
      };
      if (!active.ok || !active.top_hours?.length) {
        plan.push({
          page_row_id: pageRowId,
          page_name: page.name,
          slots: [],
          active: activeMeta,
          error:
            active.error ||
            "Không có giờ tích cực từ Graph — chọn mode fixed hoặc giờ thủ công",
        });
        continue;
      }
      slots = buildSlotsFromActiveHours(active.top_hours, {
        daysAhead: body.days_ahead || 3,
        postsPerDay: body.posts_per_day || 2,
        tzOffsetMinutes: tz,
      });
      if (!slots.length) {
        plan.push({
          page_row_id: pageRowId,
          page_name: page.name,
          slots: [],
          active: activeMeta,
          error:
            "Slot trống (giờ peak đã qua hôm nay hoặc ngoài cửa sổ 10p–30 ngày)",
        });
        continue;
      }
    }

    // filter valid window again
    const now = Date.now();
    slots = slots.filter(
      (d) =>
        d.getTime() >= now + 10 * 60 * 1000 &&
        d.getTime() <= now + 30 * 24 * 60 * 60 * 1000
    );

    plan.push({
      page_row_id: pageRowId,
      page_name: page.name,
      slots,
      active: activeMeta,
      error: slots.length ? null : "Không còn slot hợp lệ",
    });
  }

  if (dryRun) {
    return {
      dry_run: true,
      mode,
      tz_offset_minutes: tz,
      plan: plan.map((p) => ({
        ...p,
        slots: p.slots.map((d) => ({
          iso: d.toISOString(),
          unix: Math.floor(d.getTime() / 1000),
          local_label: formatLocal(d, tz),
        })),
      })),
    };
  }

  const results = [];
  for (const p of plan) {
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
      // small delay to be gentle on Graph
      await sleep(400);
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
