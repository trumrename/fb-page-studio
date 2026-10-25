import { getDb } from "../db/index.js";

function shiftDay(day, delta) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function saveFollowerSnapshot(pageRowId, followers, fanCount, day) {
  if (!Number.isFinite(Number(followers))) return false;
  const snapshotDay = day || new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  getDb().prepare(`
    INSERT INTO page_follower_history (page_row_id, snapshot_day, followers_count, fan_count, captured_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(page_row_id, snapshot_day) DO UPDATE SET
      followers_count=excluded.followers_count, fan_count=excluded.fan_count, captured_at=datetime('now')
  `).run(Number(pageRowId), snapshotDay, Number(followers), Number.isFinite(Number(fanCount)) ? Number(fanCount) : null);
  return true;
}

export function snapshotCurrentFollowers(day) {
  const rows = getDb().prepare(`SELECT id, followers_count, fan_count FROM fb_pages WHERE status='active' AND followers_count IS NOT NULL`).all();
  let saved = 0;
  for (const row of rows) if (saveFollowerSnapshot(row.id, row.followers_count, row.fan_count, day)) saved++;
  return saved;
}

function growthFor(pageRowId, currentFollowers, day, days) {
  if (!Number.isFinite(Number(currentFollowers))) return null;
  const target = shiftDay(day, -days);
  const base = getDb().prepare(`
    SELECT snapshot_day, followers_count FROM page_follower_history
    WHERE page_row_id=? AND snapshot_day<=? ORDER BY snapshot_day DESC LIMIT 1
  `).get(Number(pageRowId), target);
  if (!base || !Number.isFinite(Number(base.followers_count))) return null;
  const current = Number(currentFollowers);
  const start = Number(base.followers_count);
  const delta = current - start;
  const percent = start > 0 ? Math.round((delta / start) * 10000) / 100 : null;
  return { days, start, end: current, delta, percent, baseline_day: base.snapshot_day };
}

export function getFollowerGrowth(pageRowId, currentFollowers, day) {
  return {
    d1: growthFor(pageRowId, currentFollowers, day, 1),
    d3: growthFor(pageRowId, currentFollowers, day, 3),
    d7: growthFor(pageRowId, currentFollowers, day, 7),
    d30: growthFor(pageRowId, currentFollowers, day, 30),
  };
}

/** Follow đúng 1 ngày VN (null nếu chưa có snapshot). */
export function getFollowOnDay(pageRowId, day) {
  const row = getDb()
    .prepare(
      `SELECT followers_count, fan_count, snapshot_day, captured_at
       FROM page_follower_history
       WHERE page_row_id = ? AND snapshot_day = ?`
    )
    .get(Number(pageRowId), String(day));
  if (!row || !Number.isFinite(Number(row.followers_count))) return null;
  return {
    followers: Number(row.followers_count),
    fans: Number.isFinite(Number(row.fan_count)) ? Number(row.fan_count) : null,
    day: row.snapshot_day,
    captured_at: row.captured_at || null,
  };
}

/** Snapshot follow cho danh sách page_row_id (không phải toàn DB). */
export function snapshotFollowersForPages(pageRowIds = [], day) {
  const ids = [
    ...new Set(
      (Array.isArray(pageRowIds) ? pageRowIds : [])
        .map(Number)
        .filter((n) => n > 0)
    ),
  ];
  if (!ids.length) return 0;
  const snapshotDay =
    day ||
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Ho_Chi_Minh",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  const db = getDb();
  const get = db.prepare(
    `SELECT id, followers_count, fan_count FROM fb_pages WHERE id = ? AND status = 'active'`
  );
  let saved = 0;
  for (const id of ids) {
    const row = get.get(id);
    if (!row || !Number.isFinite(Number(row.followers_count))) continue;
    if (saveFollowerSnapshot(row.id, row.followers_count, row.fan_count, snapshotDay)) {
      saved += 1;
    }
  }
  return saved;
}
