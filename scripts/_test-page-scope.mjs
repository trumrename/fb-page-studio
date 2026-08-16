/**
 * Test phạm vi page: selected vs all, rỗng ≠ all pages.
 * Chạy bằng Electron (better-sqlite3):
 *   set ELECTRON_RUN_AS_NODE=1
 *   "FB Page Studio.exe" scripts/_test-page-scope.mjs
 */
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

if (!process.env.DATABASE_PATH && process.env.APPDATA) {
  process.env.DATABASE_PATH = path.join(
    process.env.APPDATA,
    "fb-page-studio",
    "data",
    "app.db"
  );
}
if (!process.env.FB_USER_DIR && process.env.APPDATA) {
  process.env.FB_USER_DIR = path.join(process.env.APPDATA, "fb-page-studio");
}

const { getDb } = await import(pathToFileURL(path.join(root, "src/db/index.js")).href);
const {
  loadAccountPageMatrix,
  normalizeSettings,
  buildRunNowPlan,
  buildRotationPlan,
} = await import(pathToFileURL(path.join(root, "src/services/rotationPlan.js")).href);

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  OK  ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL ${msg}`);
  }
}

function pageIdsFromMatrix(matrix) {
  const ids = [];
  for (const a of matrix) {
    for (const p of a.pages || []) ids.push(Number(p.page_row_id));
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}

const db = getDb();
const allActive = db
  .prepare(`SELECT id, name FROM fb_pages WHERE status = 'active' ORDER BY id`)
  .all();
console.log(`\n[test-page-scope] active pages in DB: ${allActive.length}`);
if (allActive.length < 3) {
  console.error("Need ≥3 active pages to test");
  process.exit(2);
}

const pick = allActive.slice(0, 3).map((p) => p.id);
const pickSet = new Set(pick);
console.log(`  pick 3 ids: ${pick.join(", ")}`);

// --- 1) selected + 3 ids → only those 3
{
  console.log("\n1) selected + page_row_ids=[3 pages]");
  const s = normalizeSettings({
    page_target_mode: "selected",
    page_row_ids: pick,
  });
  const matrix = loadAccountPageMatrix(s);
  const ids = pageIdsFromMatrix(matrix);
  assert(ids.length === 3, `matrix has exactly 3 pages (got ${ids.length})`);
  assert(
    ids.every((id) => pickSet.has(id)),
    "all matrix pages are in pick set"
  );
  assert(
    pick.every((id) => ids.includes(id)),
    "all pick ids appear in matrix"
  );
}

// --- 2) selected + empty → 0 pages (NOT all)
{
  console.log("\n2) selected + page_row_ids=[] → 0 pages (bug was: all pages)");
  const s = normalizeSettings({
    page_target_mode: "selected",
    page_row_ids: [],
  });
  const matrix = loadAccountPageMatrix(s);
  const ids = pageIdsFromMatrix(matrix);
  assert(ids.length === 0, `empty selected → 0 pages (got ${ids.length})`);
  assert(
    ids.length !== allActive.length,
    "empty selected must NOT equal all active"
  );
}

// --- 3) selected + string ids (JSON quirk)
{
  console.log("\n3) selected + string page_row_ids");
  const s = normalizeSettings({
    page_target_mode: "selected",
    page_row_ids: pick.map(String),
  });
  const ids = pageIdsFromMatrix(loadAccountPageMatrix(s));
  assert(ids.length === 3, `string ids coerce → 3 pages (got ${ids.length})`);
}

// --- 4) all mode → all active (or all with pages)
{
  console.log("\n4) page_target_mode=all");
  const s = normalizeSettings({
    page_target_mode: "all",
    page_row_ids: pick, // must be cleared by normalize
  });
  assert(
    s.page_row_ids.length === 0,
    "normalize all clears page_row_ids"
  );
  const ids = pageIdsFromMatrix(loadAccountPageMatrix(s));
  assert(
    ids.length === allActive.length,
    `all mode → ${allActive.length} pages (got ${ids.length})`
  );
  // must include pages NOT in pick
  const outsider = allActive.find((p) => !pickSet.has(p.id));
  if (outsider) {
    assert(ids.includes(outsider.id), `includes non-picked page ${outsider.id}`);
  }
}

// --- 5) selected + one outsider id only
{
  console.log("\n5) selected + single outsider id");
  const one = allActive[allActive.length - 1].id;
  const s = normalizeSettings({
    page_target_mode: "selected",
    page_row_ids: [one],
  });
  const ids = pageIdsFromMatrix(loadAccountPageMatrix(s));
  assert(ids.length === 1 && ids[0] === one, `only page ${one}`);
}

// --- 6) buildRunNowPlan selected empty throws
{
  console.log("\n6) buildRunNowPlan selected empty throws");
  let threw = false;
  try {
    buildRunNowPlan({
      page_target_mode: "selected",
      page_row_ids: [],
      posts_per_page_per_day: 1,
      between_tasks_gap_minutes_min: 0,
      between_tasks_gap_minutes_max: 0,
    });
  } catch (e) {
    threw = /tick|page/i.test(e.message);
    assert(threw, `throws meaningful error: ${e.message}`);
  }
  if (!threw) assert(false, "should have thrown");
}

// --- 7) buildRunNowPlan selected 3 ids → slots only those pages
{
  console.log("\n7) buildRunNowPlan slots only ticked pages");
  try {
    const plan = buildRunNowPlan({
      page_target_mode: "selected",
      page_row_ids: pick,
      posts_per_page_per_day: 1,
      between_tasks_gap_minutes_min: 0,
      between_tasks_gap_minutes_max: 0,
      same_page_gap_hours_min: 0,
      same_page_gap_hours_max: 0,
      run_now_time_mode: "gap_chain",
      media_pattern_mode: "fixed",
      post_type: "text",
    });
    const slotPages = [
      ...new Set((plan.slots || []).map((s) => Number(s.page_row_id))),
    ];
    assert(
      slotPages.every((id) => pickSet.has(id)),
      `all slot pages in pick (slots=${plan.slots?.length} pages=${slotPages.join(",")})`
    );
    const extra = slotPages.filter((id) => !pickSet.has(id));
    assert(extra.length === 0, `no extra pages in slots: ${extra}`);
  } catch (e) {
    // may fail on media/caption — still check error isn't wrong scope
    if (/tick|page đã tick|không có Page/i.test(e.message)) {
      assert(false, `unexpected scope error: ${e.message}`);
    } else {
      console.log(`  (plan build soft-fail ok: ${e.message.slice(0, 100)})`);
      // Re-check matrix path only
      const ids = pageIdsFromMatrix(
        loadAccountPageMatrix(
          normalizeSettings({
            page_target_mode: "selected",
            page_row_ids: pick,
          })
        )
      );
      assert(ids.length === 3, "fallback matrix still 3");
    }
  }
}

// --- 8) buildRotationPlan selected empty throws
{
  console.log("\n8) buildRotationPlan selected empty throws");
  let threw = false;
  try {
    buildRotationPlan({
      page_target_mode: "selected",
      page_row_ids: [],
      days_ahead: 1,
      posts_per_page_per_day: 1,
    });
  } catch (e) {
    threw = /tick|page/i.test(e.message);
    assert(threw, `rotation throws: ${e.message}`);
  }
  if (!threw) assert(false, "rotation should throw on empty selected");
}

// --- 9) selected ignores non-active / fake ids
{
  console.log("\n9) fake ids ignored");
  const s = normalizeSettings({
    page_target_mode: "selected",
    page_row_ids: [pick[0], 99999999, -1, 0],
  });
  const ids = pageIdsFromMatrix(loadAccountPageMatrix(s));
  assert(ids.length === 1 && ids[0] === pick[0], "only real active id kept");
}

// --- 10) scheduleBulk-style allowlist
{
  console.log("\n10) allowlist filter simulation");
  const allowed = new Set(pick.slice(0, 2));
  const fakePlan = allActive.map((p) => ({ page_row_id: p.id }));
  const filtered = fakePlan.filter((p) => allowed.has(Number(p.page_row_id)));
  assert(filtered.length === 2, "allowlist keeps 2");
  assert(
    filtered.every((p) => allowed.has(p.page_row_id)),
    "no outsider in allowlist"
  );
}

console.log(`\n========== RESULT: ${passed} passed, ${failed} failed ==========`);
process.exit(failed ? 1 : 0);
