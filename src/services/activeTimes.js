/**
 * Page "active times" from Graph Insights (when fans are online).
 * Metric: page_fans_online (hourly 0–23). No invented data — empty/error if API fails.
 */
import { graphGetSoft } from "./facebook.js";
import { getDb } from "../db/index.js";
import { decryptToken } from "./crypto.js";

/**
 * Aggregate hourly scores from page_fans_online values.
 * FB returns value as object: { "0": n, "1": n, ... "23": n } (often PST/PDT).
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

/**
 * Fetch active times for a page via Graph insights.
 * Tries page_fans_online then page_follows_online-style fallbacks — never fabricates.
 */
export async function fetchActiveTimes(pageId, pageToken) {
  const tried = [];
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
          "Giờ Meta thường theo múi giờ page / PST; đối chiếu UI Page Insights. Tool map theo offset bạn chọn khi hẹn.",
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
      "Không có dữ liệu giờ online (page nhỏ / thiếu read_insights / metric deprecated)",
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
 * Load page row + token, fetch active times, cache on page_post_config.
 * Fallback: preferred_hours (user) if Graph metric deprecated/empty.
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
  const preferred = parsePreferredHours(cfg?.preferred_hours_json);

  if (!force && cfg?.active_hours_json) {
    try {
      const cached = JSON.parse(cfg.active_hours_json);
      if (cached?.ok && Array.isArray(cached.top_hours) && cached.top_hours.length) {
        const ageMs = cfg.active_hours_at
          ? Date.now() - new Date(cfg.active_hours_at.replace(" ", "T") + "Z").getTime()
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
      /* refetch */
    }
  }

  const token = decryptToken(page.page_token_enc);
  let result = await fetchActiveTimes(page.page_id, token);

  // Graph no longer exposes page_fans_online (deprecated Nov 2025) — use preferred hours
  if (!result.ok && preferred.length) {
    result = {
      ok: true,
      source: "preferred",
      metric: "preferred_hours",
      hourly: preferred.map((h) => ({ hour: h, score: 1, samples: 0 })),
      top_hours: preferred,
      peak_hour: preferred[0],
      timezone_note:
        "Graph không còn page_fans_online — đang dùng giờ ưa thích bạn đã lưu cho page (không phải data Meta).",
      preferred_hours: preferred,
      graph_error: result.error,
      tried: result.tried,
    };
  } else if (result.ok) {
    result = { ...result, source: "insights", preferred_hours: preferred };
  } else {
    result = {
      ...result,
      source: "none",
      preferred_hours: preferred,
      error:
        (result.error || "Không có data giờ online") +
        " · Meta đã deprecate page_fans_online. Hãy LƯU giờ ưa thích cho page (vd 9,12,19,21) rồi bấm lại.",
    };
  }

  db.prepare(
    `INSERT INTO page_post_config (page_row_id, active_hours_json, active_hours_at, updated_at)
     VALUES (?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(page_row_id) DO UPDATE SET
       active_hours_json = excluded.active_hours_json,
       active_hours_at = excluded.active_hours_at,
       updated_at = datetime('now')`
  ).run(pageRowId, JSON.stringify(result));

  return {
    ...result,
    preferred_hours: preferred,
    page: { id: page.id, page_id: page.page_id, name: page.name },
    cached: false,
  };
}

/**
 * Build local-date schedule slots from top hours.
 * @param {number[]} topHours hours 0-23 in "page local" (user offset)
 * @param {object} opts { daysAhead, postsPerDay, tzOffsetMinutes, fromDate? }
 * @returns {Date[]} future Date objects (JS local constructed via UTC offset math)
 */
export function buildSlotsFromActiveHours(topHours, opts = {}) {
  const daysAhead = Math.min(30, Math.max(1, Number(opts.daysAhead) || 3));
  const postsPerDay = Math.min(10, Math.max(1, Number(opts.postsPerDay) || 2));
  const tzOffsetMin = Number(opts.tzOffsetMinutes);
  const offsetMin = Number.isFinite(tzOffsetMin) ? tzOffsetMin : 420; // default VN UTC+7

  const hours = (topHours || []).slice(0, postsPerDay);
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
      // Construct wall time in target TZ → convert to real UTC ms
      // UTC ms = Date.UTC(y,m,d,hour,0,0) - offsetMin*60*1000
      const base = new Date(Date.UTC(y0, m0, d0 + day, hour, 0, 0));
      const realMs = base.getTime() - offsetMin * 60 * 1000;
      if (realMs < minMs || realMs > maxMs) continue;
      slots.push(new Date(realMs));
    }
  }

  return slots.sort((a, b) => a - b);
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
