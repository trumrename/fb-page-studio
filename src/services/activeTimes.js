/**
 * Page "active times" for bulk Facebook scheduling.
 *
 * Meta deprecated page_fans_online / page_fans_online_per_day (Graph Insights
 * error #100 — not a valid metric). There is no official free replacement that
 * returns fans-online-by-hour for Pages.
 *
 * Source order (never invent "Meta insights"):
 *  1. User preferred_hours on the page (saved)
 *  2. Optional legacy Graph metrics if env FB_TRY_LEGACY_ONLINE_INSIGHTS=1
 *  3. Tool default hours (VN-friendly 9,12,19,21) — labeled source=default
 */
import { graphGetSoft } from "./facebook.js";
import { getDb } from "../db/index.js";
import { decryptToken } from "./crypto.js";

/** Default posting hours when Meta has no metric and user has not set preferred. */
export const DEFAULT_PREFERRED_HOURS = [9, 12, 19, 21];

/**
 * Aggregate hourly scores from insights values.
 * FB returns value as object: { "0": n, "1": n, ... "23": n }.
 */
export function aggregateHourlyScores(insightRows) {
  const hours = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    score: 0,
    samples: 0,
  }));

  for (const row of insightRows || []) {
    for (const v of row.values || []) {
      const val = v.value;
      if (!val || typeof val !== "object" || Array.isArray(val)) continue;
      for (let h = 0; h < 24; h++) {
        const key = String(h);
        const n = Number(val[key] ?? val[h]);
        if (Number.isFinite(n) && n >= 0) {
          hours[h].score += n;
          hours[h].samples += 1;
        }
      }
    }
  }

  return hours.map((h) => ({
    hour: h.hour,
    score: h.samples ? Math.round(h.score / h.samples) : 0,
    samples: h.samples,
  }));
}

/** Top N hours by score (only hours with score > 0). */
export function pickTopHours(hourly, n = 3) {
  return [...hourly]
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || a.hour - b.hour)
    .slice(0, Math.max(1, n))
    .map((h) => h.hour);
}

function resultFromHours(hours, { source, metric, timezone_note, extra = {} }) {
  const list = parsePreferredHours(hours);
  return {
    ok: list.length > 0,
    source,
    metric,
    hourly: list.map((h) => ({ hour: h, score: 1, samples: 0 })),
    top_hours: list,
    peak_hour: list[0] ?? null,
    timezone_note,
    preferred_hours: list,
    ...extra,
  };
}

/**
 * Fetch active times for a page via Graph insights (optional / rarely works).
 * Default: skip dead metrics unless FB_TRY_LEGACY_ONLINE_INSIGHTS=1.
 */
export async function fetchActiveTimes(pageId, pageToken) {
  const tryLegacy =
    String(process.env.FB_TRY_LEGACY_ONLINE_INSIGHTS || "").trim() === "1";
  if (!tryLegacy) {
    return {
      ok: false,
      error:
        "Meta đã deprecate page_fans_online (không còn metric giờ fan online trên Graph).",
      hourly: [],
      top_hours: [],
      peak_hour: null,
      metric: null,
      skipped_graph: true,
      tried: [],
    };
  }

  const tried = [];
  // Legacy only — usually returns (#100) invalid metric.
  const metrics = ["page_fans_online", "page_fans_online_per_day"];

  for (const metric of metrics) {
    const r = await graphGetSoft(`/${pageId}/insights`, pageToken, {
      metric,
      period: "day",
      date_preset: "last_7d",
    });
    tried.push({
      metric,
      ok: r.ok,
      error: r.ok ? null : r.error,
      rows: r.ok ? (r.data?.data || []).length : 0,
    });
    if (!r.ok) continue;
    const rows = (r.data?.data || []).filter((x) => x.name === metric || !x.name);
    const useRows = rows.length ? rows : r.data?.data || [];
    const hourly = aggregateHourlyScores(useRows);
    const hasData = hourly.some((h) => h.score > 0);
    if (hasData) {
      const top = pickTopHours(hourly, 5);
      return {
        ok: true,
        metric,
        hourly,
        top_hours: top,
        peak_hour: top[0] ?? null,
        timezone_note:
          "Giờ Meta (legacy) — thường theo múi giờ page / PST; đối chiếu UI Page Insights.",
        days_in_response: useRows.reduce(
          (n, row) => n + (row.values?.length || 0),
          0
        ),
        tried,
      };
    }
  }

  return {
    ok: false,
    error:
      tried.map((t) => `${t.metric}: ${t.error || "empty"}`).join(" · ") ||
      "Không có dữ liệu giờ online (metric deprecated / thiếu quyền)",
    hourly: [],
    top_hours: [],
    peak_hour: null,
    metric: null,
    tried,
  };
}

function parsePreferredHours(raw) {
  if (!raw) return [];
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) return [];
    return [
      ...new Set(
        arr
          .map((h) => Number(h))
          .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
      ),
    ].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** Save user preferred active hours (0–23) for a page — not FB data. */
export function savePreferredHours(pageRowId, hours) {
  const list = parsePreferredHours(hours);
  const db = getDb();
  db.prepare(
    `INSERT INTO page_post_config (page_row_id, preferred_hours_json, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(page_row_id) DO UPDATE SET
       preferred_hours_json = excluded.preferred_hours_json,
       updated_at = datetime('now')`
  ).run(pageRowId, JSON.stringify(list));
  return list;
}

export function getPreferredHours(pageRowId) {
  const row = getDb()
    .prepare(
      `SELECT preferred_hours_json FROM page_post_config WHERE page_row_id = ?`
    )
    .get(pageRowId);
  return parsePreferredHours(row?.preferred_hours_json);
}

/**
 * Apply the same preferred hours to many pages (bulk schedule helper).
 */
export function savePreferredHoursBulk(pageRowIds, hours) {
  const list = parsePreferredHours(hours);
  const ids = (pageRowIds || []).map(Number).filter((n) => n > 0);
  const saved = [];
  for (const id of ids) {
    savePreferredHours(id, list);
    saved.push({ page_row_id: id, preferred_hours: list });
  }
  return { hours: list, pages: saved.length, items: saved };
}

/**
 * Resolve hours for scheduling without calling Graph on every bulk dry-run.
 * Preferred → (optional legacy Graph) → default hours.
 */
export async function getActiveTimesForPageRow(pageRowId, { force = false } = {}) {
  const db = getDb();
  const page = db
    .prepare(
      `SELECT id, page_id, name, page_token_enc, status FROM fb_pages WHERE id = ?`
    )
    .get(pageRowId);
  if (!page || page.status !== "active") {
    throw new Error("Page not found or inactive");
  }
  if (!page.page_token_enc) {
    throw new Error("Thiếu page token — Connect Facebook lại");
  }

  const cfg = db
    .prepare(
      `SELECT active_hours_json, active_hours_at, preferred_hours_json FROM page_post_config WHERE page_row_id = ?`
    )
    .get(pageRowId);
  let preferred = parsePreferredHours(cfg?.preferred_hours_json);

  // Fast path: user preferred hours (primary after Meta deprecation)
  if (preferred.length) {
    const result = resultFromHours(preferred, {
      source: "preferred",
      metric: "preferred_hours",
      timezone_note:
        "Giờ ưa thích bạn đã lưu cho page (Meta không còn metric fan-online).",
    });
    cacheActiveHours(pageRowId, result);
    return {
      ...result,
      page: { id: page.id, page_id: page.page_id, name: page.name },
      cached: false,
    };
  }

  // Cache only successful insights (rare) within 24h
  if (!force && cfg?.active_hours_json) {
    try {
      const cached = JSON.parse(cfg.active_hours_json);
      if (
        cached?.ok &&
        cached?.source === "insights" &&
        Array.isArray(cached.top_hours) &&
        cached.top_hours.length
      ) {
        const ageMs = cfg.active_hours_at
          ? Date.now() -
            new Date(cfg.active_hours_at.replace(" ", "T") + "Z").getTime()
          : Infinity;
        if (Number.isFinite(ageMs) && ageMs < 24 * 60 * 60 * 1000) {
          return {
            ...cached,
            preferred_hours: preferred,
            page: { id: page.id, page_id: page.page_id, name: page.name },
            cached: true,
            cached_at: cfg.active_hours_at,
          };
        }
      }
    } catch {
      /* refetch / fallback */
    }
  }

  // Optional legacy Graph (off by default — always #100 nowadays)
  let graphResult = {
    ok: false,
    error:
      "Meta đã deprecate page_fans_online — dùng giờ ưa thích / default tool.",
    tried: [],
  };
  if (String(process.env.FB_TRY_LEGACY_ONLINE_INSIGHTS || "").trim() === "1") {
    const token = decryptToken(page.page_token_enc);
    graphResult = await fetchActiveTimes(page.page_id, token);
  }

  let result;
  if (graphResult.ok && graphResult.top_hours?.length) {
    result = {
      ...graphResult,
      source: "insights",
      preferred_hours: preferred,
    };
  } else {
    // Tool default — auto-seed preferred so next bulk dry-run is silent & editable
    const defaults = [...DEFAULT_PREFERRED_HOURS];
    preferred = savePreferredHours(pageRowId, defaults);
    result = resultFromHours(preferred, {
      source: "default",
      metric: "default_preferred_hours",
      timezone_note:
        "Meta không còn page_fans_online. Tool đã gán preset giờ VN 9,12,19,21 cho page này — sửa trong config page nếu muốn.",
      extra: {
        auto_seeded_preferred: true,
        graph_error: graphResult.error || null,
        tried: graphResult.tried || [],
      },
    });
  }

  cacheActiveHours(pageRowId, result);

  return {
    ...result,
    preferred_hours: preferred.length ? preferred : result.top_hours,
    page: { id: page.id, page_id: page.page_id, name: page.name },
    cached: false,
  };
}

function cacheActiveHours(pageRowId, result) {
  getDb()
    .prepare(
      `INSERT INTO page_post_config (page_row_id, active_hours_json, active_hours_at, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(page_row_id) DO UPDATE SET
         active_hours_json = excluded.active_hours_json,
         active_hours_at = excluded.active_hours_at,
         updated_at = datetime('now')`
    )
    .run(pageRowId, JSON.stringify(result));
}

/**
 * Expand / sample preferred hours for posts_per_day.
 * - If enough preferred hours: spread evenly across the list (not just earliest).
 * - If short: fill from VN preset then daytime 8–22.
 */
function expandHoursForPostsPerDay(topHours, postsPerDay) {
  const want = Math.min(10, Math.max(1, Number(postsPerDay) || 2));
  let hours = [
    ...new Set(
      (topHours || [])
        .map((h) => Number(h))
        .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
    ),
  ].sort((a, b) => a - b);
  if (!hours.length) hours = [...DEFAULT_PREFERRED_HOURS];

  if (hours.length >= want) {
    if (hours.length === want) return hours;
    // Evenly sample preferred hours (e.g. 9,12,19,21 + 2/day → 9,21 not 9,12)
    const picked = [];
    for (let i = 0; i < want; i++) {
      const idx =
        want === 1
          ? Math.floor((hours.length - 1) / 2)
          : Math.round((i * (hours.length - 1)) / (want - 1));
      picked.push(hours[idx]);
    }
    return [...new Set(picked)].sort((a, b) => a - b);
  }

  // Fill from default VN preset without duplicates
  for (const h of DEFAULT_PREFERRED_HOURS) {
    if (hours.length >= want) break;
    if (!hours.includes(h)) hours.push(h);
  }
  // Still short? walk the day
  for (let h = 8; h <= 22 && hours.length < want; h++) {
    if (!hours.includes(h)) hours.push(h);
  }
  return hours.slice(0, want).sort((a, b) => a - b);
}

/**
 * Build local-date schedule slots from top hours (preferred / active).
 * - Jitter phút trong khung giờ (tự nhiên hơn luôn :00)
 * - Min gap giữa 2 bài cùng page (anti-spam / interval)
 * - Bù giờ nếu posts_per_day > số giờ đã lưu
 *
 * @param {number[]} topHours hours 0-23 in "page local" (user offset)
 * @param {object} opts {
 *   daysAhead, postsPerDay, tzOffsetMinutes,
 *   minGapMinutes?, jitterMinutes?,
 *   pageStaggerMinutes? — offset all slots for this page (bulk multi-page)
 * }
 * @returns {Date[]} future Date objects
 */
export function buildSlotsFromActiveHours(topHours, opts = {}) {
  const daysAhead = Math.min(30, Math.max(1, Number(opts.daysAhead) || 3));
  const postsPerDay = Math.min(10, Math.max(1, Number(opts.postsPerDay) || 2));
  const tzOffsetMin = Number(opts.tzOffsetMinutes);
  const offsetMin = Number.isFinite(tzOffsetMin) ? tzOffsetMin : 420; // default VN UTC+7
  const minGapMin = Math.max(
    0,
    Number.isFinite(Number(opts.minGapMinutes)) ? Number(opts.minGapMinutes) : 0
  );
  // Note: 0 is valid (no in-hour jitter) — do not use `|| 12` (0 is falsy)
  const jitterRaw = Number(opts.jitterMinutes);
  const jitterMin = Math.min(
    45,
    Math.max(0, Number.isFinite(jitterRaw) ? jitterRaw : 12)
  );
  const staggerRaw = Number(opts.pageStaggerMinutes);
  const staggerMin = Math.max(
    0,
    Math.min(90, Number.isFinite(staggerRaw) ? staggerRaw : 0)
  );

  const hours = expandHoursForPostsPerDay(topHours, postsPerDay);
  if (!hours.length) return [];

  const now = Date.now();
  const minMs = now + 10 * 60 * 1000;
  const maxMs = now + 30 * 24 * 60 * 60 * 1000;
  const slots = [];

  // "Today" in target timezone
  const nowInTz = new Date(now + offsetMin * 60 * 1000);
  const y0 = nowInTz.getUTCFullYear();
  const m0 = nowInTz.getUTCMonth();
  const d0 = nowInTz.getUTCDate();

  for (let day = 0; day < daysAhead; day++) {
    for (const hour of hours) {
      // Random minute in hour (5..55) — tránh mọi bài đều :00
      const minute =
        jitterMin > 0
          ? Math.min(55, 5 + Math.floor(Math.random() * Math.max(1, jitterMin * 2)))
          : 0;
      const base = new Date(Date.UTC(y0, m0, d0 + day, hour, minute, 0));
      // Stagger multi-page bulk so pages don't hit Graph at the same second
      const realMs =
        base.getTime() - offsetMin * 60 * 1000 + staggerMin * 60 * 1000;
      if (realMs < minMs || realMs > maxMs) continue;
      slots.push(new Date(realMs));
    }
  }

  slots.sort((a, b) => a.getTime() - b.getTime());

  // Enforce min gap between consecutive posts (same page)
  if (minGapMin > 0 && slots.length > 1) {
    const gapMs = minGapMin * 60 * 1000;
    const out = [slots[0]];
    for (let i = 1; i < slots.length; i++) {
      const prev = out[out.length - 1].getTime();
      let t = slots[i].getTime();
      if (t < prev + gapMs) t = prev + gapMs;
      if (t > maxMs) continue;
      if (t < minMs) continue;
      out.push(new Date(t));
    }
    return out;
  }

  return slots;
}

/**
 * Parse fixed times: ISO strings or "YYYY-MM-DD HH:mm" with tz offset.
 */
export function parseFixedTimes(times, tzOffsetMinutes = 420) {
  if (!Array.isArray(times)) return [];
  const out = [];
  for (const t of times) {
    if (t == null || t === "") continue;
    if (typeof t === "number" && t > 1e9) {
      out.push(new Date(t * 1000));
      continue;
    }
    const s = String(t).trim();
    // already ISO with Z or offset
    if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) out.push(d);
      continue;
    }
    // "YYYY-MM-DDTHH:mm" or "YYYY-MM-DD HH:mm" as wall time in tz
    const m = s.match(
      /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/
    );
    if (m) {
      const realMs =
        Date.UTC(
          Number(m[1]),
          Number(m[2]) - 1,
          Number(m[3]),
          Number(m[4]),
          Number(m[5]),
          Number(m[6] || 0)
        ) -
        tzOffsetMinutes * 60 * 1000;
      out.push(new Date(realMs));
      continue;
    }
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) out.push(d);
  }
  return out;
}
