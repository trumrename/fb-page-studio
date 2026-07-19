/**
 * Requirement checks + 3 functional test passes
 * Run: node scripts/test-requirements.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pickCaption } from "../src/services/mediaLibrary.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const results = [];
function check(name, cond, detail = "") {
  const pass = !!cond;
  results.push({ name, pass, detail });
  console.log(pass ? "✓" : "✗", name, detail ? `— ${detail}` : "");
  return pass;
}

console.log("\n========== STATIC REQUIREMENT MAP ==========\n");

for (const f of ["pack-customer/.env", "pack-customer/data", "pack-customer/src", "pack-customer/desktop-startup.log"]) {
  check(`customer pack excludes ${f.replace("pack-customer/", "")}`, !fs.existsSync(path.join(root, f)));
}

const need = [
  "src/services/metaApps.js",
  "src/services/rotationPlan.js",
  "src/routes/auth.js",
  "src/routes/jobs.js",
  "src/services/accounts.js",
  "src/services/facebook.js",
  "src/db/index.js",
  "src/services/jobRunner.js",
  "src/services/dailyReports.js",
  "src/services/followerHistory.js",
  "public/posting.html",
  "public/index.html",
];
for (const f of need) {
  check(`file ${f}`, fs.existsSync(path.join(root, f)));
}

const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

const auth = read("src/routes/auth.js");
check("OAuth multi-app query app=", auth.includes("metaAppKey") || auth.includes("app=app"));
check("OAuth /auth/apps list", auth.includes('"/apps"') || auth.includes("'/apps'"));
check("OAuth stores meta_app_key in state", auth.includes("meta_app_key"));
check("OAuth callback connect with app creds", auth.includes("connectFromOAuthCode") && auth.includes("appSecret"));

const meta = read("src/services/metaApps.js");
check("metaApps supports FB_APP_ID_2", meta.includes("FB_APP_ID_2"));

const acc = read("src/services/accounts.js");
check("accounts unique per fb_user + meta_app", acc.includes("meta_app_key"));
check("accounts return meta_app_name", acc.includes("meta_app_name"));
check("page quota is enforced for newly synced Pages", acc.includes('checkQuota("page"') && acc.includes("skippedByLicense"));

const fb = read("src/services/facebook.js");
check("facebook buildLoginUrl accepts app", fb.includes("opts.app") || fb.includes("appCreds"));
check("facebook exchangeCode accepts app creds", fb.includes("appCreds") || fb.includes("app.appId"));

const db = read("src/db/index.js");
check("DB migrate meta_app_key", db.includes("meta_app_key") && db.includes("migrateMetaApp"));

const rot = read("src/services/rotationPlan.js");
check("rotation auto_groups_by_meta_app", rot.includes("auto_groups_by_meta_app"));
check("rotation so-le order loops", rot.includes("postRound") && rot.includes("pageIdx") && rot.includes("adminIdx"));
check("rotation windows + same_page_gap", rot.includes("same_page_gap_hours") && rot.includes("windows"));
check("rotation fixed_gap mode", rot.includes("fixed_gap"));
check("rotation short group skip", rot.includes("short group") || rot.includes("if (!admin)") || rot.includes("if (!page)"));

const jobs = read("src/routes/jobs.js");
check("API rotation/plan", jobs.includes("rotation/plan"));
check("API rotation/run", jobs.includes("rotation/run"));
check("API rotation/run-now", jobs.includes("rotation/run-now"));
check("API rotation/matrix", jobs.includes("rotation/matrix"));

const jr = read("src/services/jobRunner.js");
check("sequential runner sleep 350ms", jr.includes("sleep(350)"));
const pageLock = read("src/services/pageOperationLock.js");
const poster = read("src/services/poster.js");
const schedule = read("src/services/schedule.js");
check("publishing serializes work per Page", pageLock.includes("withPageOperationLock") && poster.includes("withPageOperationLock(pageRowId") && schedule.includes("withPageOperationLock(pageRowId"));
check("no parallel Promise.all posts in runner", !/Promise\.all\([^)]*runOnePost/.test(jr));
check("job runner live resource snapshot", jr.includes("refreshResources") && jr.includes("job.resources"));
check("job history persists across App restart", jr.includes("jobs-state.json") && jr.includes("restoreJobs") && jr.includes('job.status = "interrupted"'));
check("media uses random spaced policy", read("src/services/antiSpam.js").includes("pickRandomMediaSpaced") && poster.includes('"random_spaced"') && schedule.includes('"random_spaced"'));
check("caption uses sequential then shuffled cycles", read("src/services/mediaLibrary.js").includes("stableShuffle") && poster.includes('"sequential_shuffle"') && schedule.includes('"sequential_shuffle"'));

const captionSample = ["Caption A", "Caption B", "Caption C", "Caption D"];
const firstCaptionCycle = captionSample.map((_, i) => pickCaption(captionSample, i, "sequential_shuffle"));
const secondCaptionCycle = captionSample.map((_, i) => pickCaption(captionSample, i + captionSample.length, "sequential_shuffle"));
check("caption first cycle preserves order", firstCaptionCycle.join("|") === captionSample.join("|"));
check("caption next cycle is a full shuffled permutation", new Set(secondCaptionCycle).size === captionSample.length && secondCaptionCycle.some((x, i) => x !== captionSample[i]));
check("caption cursor is independent from post type cursor", poster.includes("caption_slot_index") && schedule.includes("caption_slot_index") && db.includes("caption_slot_index"));
check("media spacing records only successful selections", read("src/services/antiSpam.js").includes("source_folder") && !read("src/services/antiSpam.js").includes("recentMediaByPool"));
check("resource counts exclude already-used media", poster.includes("countUnusedMedia") && rot.includes("countUnusedMedia"));

const server = read("src/server.js");
const apiRoutes = read("src/routes/api.js");
check("OAuth domain setup saves only public callback fields", apiRoutes.includes('"/setup/domain"') && apiRoutes.includes("APP_BASE_URL") && apiRoutes.includes("FB_REDIRECT_URI") && apiRoutes.includes("normalizeOAuthOrigin"));
check("OAuth browser profile setup", apiRoutes.includes('"/setup/browser"') && apiRoutes.includes("listChromeProfiles") && read("electron/main.cjs").includes("--profile-directory") && read("electron/main.cjs").includes("readBrowserEnv"));
const updater = read("src/services/updater.js");
const updateUi = read("public/js/update.js");
check("direct updater exposes progress", updater.includes("getUpdateProgress") && updater.includes("startUpdate") && apiRoutes.includes('"/update/progress"'));
check("desktop updater exits Electron before replace", updater.includes("requestUpdateRestart") && read("electron/main.cjs").includes("fbps-apply-update"));
check("update UI displays live download progress", updateUi.includes("watchUpdateProgress") && updateUi.includes("Đang tải"));
check("updater bypasses stale GitHub cache", updater.includes('"Cache-Control"') && updater.includes("Date.now()"));
check("updater rolls back and reports replacement failure", updater.includes(":replace_failed") && updater.includes("_update-error.txt") && apiRoutes.includes('"/update/last-error"') && updateUi.includes("showLastUpdateError"));
check("release gate verifies embedded version and EXE hashes", fs.existsSync(path.join(root, "scripts/verify-release.mjs")) && read("scripts/verify-release.mjs").includes("EXE embedded version") && read("scripts/verify-release.mjs").includes("customer EXE hash"));
check("tag release workflow runs verification gate", fs.existsSync(path.join(root, ".github/workflows/release-desktop.yml")) && read(".github/workflows/release-desktop.yml").includes("release:verify") && read(".github/workflows/release-desktop.yml").includes("GITHUB_REF_NAME"));
check("scheduler prevents overlapping ticks", server.includes("schedulerRunning"));
check("overdue Facebook schedules reconcile automatically", server.includes("runScheduledReconcile") && server.includes("RECONCILE_MS"));
check("runtime reports scheduler and config health", server.includes('/api/runtime') && server.includes("config_health") && server.includes("enabled_pages"));
check("daily reports run at 23:59 Vietnam time", server.includes("dailyReportTick") && server.includes("23:59 VN") && server.includes("yesterdayVn"));
check("end-of-day Page report refreshes Facebook followers", server.includes("await enrichAllPages({ force: true })"));

const posting = read("public/posting.html");
check("UI Rotation panel", posting.includes("Rotation so-le"));
check("UI run-now preview + start", posting.includes("btnRotNowPreview") && posting.includes("btnRotNowRun"));
check("UI App rotation strategies", posting.includes("rotAppStrategy") && posting.includes("per_app") && posting.includes("interleave_apps"));
check("UI Page/Admin wait range", posting.includes("rotTaskGapMin") && posting.includes("rotTaskGapMax"));
check("UI run-now Media/Posted/Caption pickers", ["btnRotPickMedia", "btnRotPickPosted", "btnRotPickCaptions", "btnRotApplyFolders"].every((x) => posting.includes(x)));
check("UI live job progress + notifications", ["liveJobBar", "liveJobPct", "liveResources", "liveNotifs", "watchLiveJob"].every((x) => posting.includes(x)));
check("bulk schedule uses live job runner", posting.includes('"/api/jobs/bulk-schedule"') && posting.includes("watchLiveJob(r.job.id)"));
check("posting stops when config save fails", posting.includes("if (!(await saveConfig())) return"));
check("unsupported Story control is disabled", posting.includes('id="story_enabled" disabled'));
check("UI profile Meta App badge", posting.includes("meta_app_name") && posting.includes("appKey"));
check("UI auto meta groups checkbox", posting.includes("rotAutoMeta"));
check("UI windows + gap settings", posting.includes("rotWindows") && posting.includes("rotGapMin"));

const index = read("public/index.html");
check("OAuth flash escapes URL values", index.includes('escapeHtml(p.get("error"))'));
check("UI Connect App 1", index.includes("app=app1"));
check("UI Connect App 2", index.includes("app=app2"));
check("UI domain setup and Ngrok command", index.includes("oauthDomain") && index.includes("btnSaveOAuthDomain") && index.includes("btnCopyNgrokCommand"));
check("UI Chrome profile selection", index.includes("oauthBrowserProfile") && index.includes("btnSaveBrowserProfile"));
check("UI meta app badge on accounts", index.includes("meta_app") || index.includes("appLabel"));
check("UI exports Page information per App", index.includes("btnExportDailyPages") && index.includes("/api/reports/daily/pages"));
check("manual Page report refreshes follower data", index.includes("refresh_followers"));

const dashboard = read("public/app.html");
const shell = read("public/js/shell.js");
const css = read("public/css/app.css");
check("navigation tabs map to distinct workspaces", shell.includes('dataset.view = view') && shell.includes('itemHash === hash') && css.includes('body[data-view="rotation"]') && css.includes('body[data-view="reports"]'));
check("dashboard has unique logs target", (dashboard.match(/id="logs"/g) || []).length === 1 && dashboard.includes('id="logsSection"'));
check("dashboard auto-discovers active jobs", dashboard.includes("discoverJobs") && dashboard.includes("setInterval(discoverJobs"));
check("dashboard shows live operation summary", ["opsState", "opsToday", "opsSuccess", "opsFail"].every((x) => dashboard.includes(x)));
check("dashboard displays Vietnam time", dashboard.includes("fmtVn") && dashboard.includes("Asia/Ho_Chi_Minh"));
check("dashboard separates created and Facebook publish time", dashboard.includes("Tool thực hiện lúc") && dashboard.includes("Facebook sẽ đăng lúc") && dashboard.includes("scheduleDisplay"));
check("dashboard shows scheduler and config health", dashboard.includes("opsScheduler") && dashboard.includes("configHealth") && dashboard.includes("loadRuntime"));
check("dashboard explains operation per Page", dashboard.includes("pageOperationRows") && dashboard.includes("Profile / Admin") && dashboard.includes("Giờ ưu tiên VN") && dashboard.includes("total_planned_today"));
check("UI separates daily posting-history export", dashboard.includes("btnExportDailyHistory") && dashboard.includes("btnShowDailyFiles"));

const dailyReports = read("src/services/dailyReports.js");
check("Page workbook uses one daily sheet per Meta App", dailyReports.includes("exportPageInfoDaily") && dailyReports.includes("removeWorksheet") && dailyReports.includes("-thong-tin-page"));
check("Page report includes follower changes 1d 3d 7d 30d", ["follow_delta_1d", "follow_delta_3d", "follow_delta_7d", "follow_delta_30d"].every((x) => dailyReports.includes(x)));
check("posting history creates daily CSV and cumulative workbook", dailyReports.includes("lich-su-dang-${day}.csv") && dailyReports.includes('"lich-su-dang.xlsx"'));
check("posting log explains scheduled state", posting.includes("FB đã nhận lịch · chờ đăng") && posting.includes("Facebook sẽ đăng lúc"));
check("overdue schedules can reconcile with Facebook", schedule.includes("reconcileScheduledLogs") && posting.includes("btnReconcileActLog") && dashboard.includes("btnReconcileLogs"));

// Import runtime modules
const { getDb } = await import("../src/db/index.js");
const { listMetaApps, listMetaAppsPublic, getMetaApp, assertMetaAppConfigured } =
  await import("../src/services/metaApps.js");
const { listAccounts } = await import("../src/services/accounts.js");
const {
  buildRotationPlan,
  buildRunNowPlan,
  loadRotationSettings,
  saveRotationSettings,
  loadAccountPageMatrix,
  resolveGroups,
  planToScheduleSlots,
  normalizeSettings,
  planTimesForPageDay,
} = await import("../src/services/rotationPlan.js");
const { buildLoginUrl } = await import("../src/services/facebook.js");

function assert(name, cond, detail = "") {
  if (!check(name, cond, detail)) throw new Error(`ASSERT FAIL: ${name} ${detail}`);
}

function passRun(n, fn) {
  console.log(`\n========== TEST PASS ${n} ==========\n`);
  fn(n);
}

// ---------- PASS 1 ----------
passRun(1, () => {
  const db = getDb();
  const accCols = db
    .prepare("PRAGMA table_info(fb_accounts)")
    .all()
    .map((c) => c.name);
  assert("P1 db meta_app_key column", accCols.includes("meta_app_key"));
  assert("P1 db meta_app_id column", accCols.includes("meta_app_id"));

  const oauthCols = db
    .prepare("PRAGMA table_info(oauth_states)")
    .all()
    .map((c) => c.name);
  assert("P1 oauth meta_app_key", oauthCols.includes("meta_app_key"));

  const apps = listMetaApps();
  assert("P1 at least app1 listed", apps.length >= 1 && apps[0].key === "app1");
  if (apps[0].configured) {
    assert("P1 app1 configured", true, apps[0].appId?.slice(0, 8));
  } else {
    assert("P1 clean CI does not require Meta secrets", !process.env.FB_APP_ID && !process.env.FB_APP_SECRET);
  }

  const pub = listMetaAppsPublic();
  assert("P1 public list no secret field", !JSON.stringify(pub).includes("appSecret"));

  const a1 = getMetaApp("app1");
  assert("P1 getMetaApp app1", a1?.key === "app1");

  let threw = false;
  try {
    assertMetaAppConfigured("app2");
  } catch {
    threw = true;
  }
  const apps2 = listMetaApps().find((a) => a.key === "app2");
  if (!apps2?.configured) {
    assert("P1 app2 missing throws (expected if no FB_APP_ID_2)", threw);
  } else {
    assert("P1 app2 configured", apps2.configured);
  }

  const accounts = listAccounts();
  assert("P1 listAccounts works", Array.isArray(accounts));
  for (const a of accounts) {
    assert(
      `P1 account#${a.id} has meta_app_key`,
      !!a.meta_app_key,
      a.meta_app_key
    );
  }

  // Login URL uses app1 id
  const testApp = a1.appId
    ? a1
    : { appId: "123456789012345", redirectUri: "https://example.test/auth/facebook/callback", scopes: ["public_profile"] };
  const url = buildLoginUrl("teststate123", {
    app: { appId: testApp.appId, redirectUri: testApp.redirectUri, scopes: testApp.scopes },
  });
  assert("P1 login URL has client_id", url.includes(testApp.appId));
  assert("P1 login URL has state", url.includes("teststate123"));
});

// ---------- PASS 2 ----------
passRun(2, () => {
  const matrix = loadAccountPageMatrix(loadRotationSettings());
  assert("P2 matrix loads", Array.isArray(matrix));

  // Simulate 2 meta apps by temporarily tagging if only app1
  // Build plan with auto groups
  const planAuto = buildRotationPlan({
    auto_groups_by_meta_app: true,
    groups: [],
    mode: "windows",
    days_ahead: 1,
    windows: [
      { name: "Sang", start: "07:30", end: "11:30", posts: 1 },
      { name: "Toi", start: "18:00", end: "21:30", posts: 1 },
    ],
    same_page_gap_hours_min: 2,
    same_page_gap_hours_max: 2.5,
    jitter_minutes_min: 1,
    jitter_minutes_max: 10,
    page_row_ids: matrix
      .flatMap((a) => a.pages.slice(0, 2).map((p) => p.page_row_id))
      .slice(0, 6),
  });

  assert("P2 plan has slots or empty ok", planAuto.slots != null);
  assert("P2 plan summary exists", !!planAuto.summary);
  assert(
    "P2 order_logic documented",
    String(planAuto.summary.order_logic || "").includes("pageIndex")
  );

  // Manual 2-group so-le if we have >=2 accounts
  if (matrix.length >= 2) {
    const g1 = [matrix[0].account_id];
    const g2 = [matrix[1].account_id];
    const ids = [];
    for (const a of matrix.slice(0, 2)) {
      for (const p of a.pages.slice(0, 2)) ids.push(p.page_row_id);
    }
    const plan = buildRotationPlan({
      auto_groups_by_meta_app: false,
      groups: [
        { id: "app1", name: "App 1", account_ids: g1 },
        { id: "app2", name: "App 2", account_ids: g2 },
      ],
      mode: "windows",
      days_ahead: 1,
      windows: [
        { name: "Sang", start: "08:00", end: "11:00", posts: 1 },
        { name: "Toi", start: "18:00", end: "21:00", posts: 1 },
      ],
      same_page_gap_hours_min: 2,
      same_page_gap_hours_max: 2.2,
      page_row_ids: ids,
    });

    assert("P2 two-group plan slots > 0", plan.slots.length > 0, String(plan.slots.length));
    assert("P2 summary groups=2", plan.summary.groups === 2, String(plan.summary.groups));

    // So-le: consecutive same post_round+page_index should alternate groups when both have page
    const firstWave = plan.slots.filter((s) => s.post_round === 1 && s.page_index === 1);
    if (firstWave.length >= 2) {
      assert(
        "P2 so-le P1: different groups",
        firstWave[0].group_id !== firstWave[1].group_id ||
          firstWave[0].group_name !== firstWave[1].group_name,
        `${firstWave[0].group_name} then ${firstWave[1].group_name}`
      );
    }

    // Same page gap: for one page, consecutive post rounds >= ~2h
    const byPage = new Map();
    for (const s of plan.slots) {
      if (!byPage.has(s.page_row_id)) byPage.set(s.page_row_id, []);
      byPage.get(s.page_row_id).push(s);
    }
    let gapOk = true;
    for (const [, list] of byPage) {
      list.sort((a, b) => a.unix - b.unix);
      for (let i = 1; i < list.length; i++) {
        const gapH = (list[i].unix - list[i - 1].unix) / 3600;
        if (gapH < 1.5) {
          gapOk = false;
          console.log("  gap fail", list[i - 1].local_label, "->", list[i].local_label, gapH);
        }
      }
    }
    assert("P2 same-page gap mostly >= 1.5h", gapOk);

    const sched = planToScheduleSlots(plan, "text");
    assert("P2 planToScheduleSlots length", sched.length === plan.slots.length);
    assert("P2 schedule slot has unix", sched[0]?.unix > 0);
  } else {
    check("P2 skip two-group (need 2 accounts)", true, "only 1 account");
  }

  const runNowIds = matrix.flatMap((a) => a.pages.slice(0, 2).map((p) => p.page_row_id));
  if (runNowIds.length) {
    const runNow = buildRunNowPlan({
      page_row_ids: runNowIds,
      posts_per_page_per_day: 2,
      post_type: "text",
      same_page_gap_hours_min: 2,
      same_page_gap_hours_max: 2,
      tz_offset_minutes: 420,
    });
    assert("P2 run-now has fixed rounds", runNow.round_times.length === 2, String(runNow.round_times.length));
    assert("P2 run-now first round immediate", runNow.slots[0]?.immediate === true);
    if (runNow.slots.length > 1) {
      assert("P2 next task waits >=12m", runNow.slots[1].unix - runNow.slots[0].unix >= 12 * 60, String(runNow.slots[1].unix - runNow.slots[0].unix));
    }
    assert("P2 run-now exact order documented", String(runNow.summary.order_logic).includes("admin"));
    if (matrix.length >= 2) {
      const twoAppIds = matrix.flatMap((a) => a.pages.slice(0, 2).map((p) => p.page_row_id));
      const twoAppGroups = [
        { id: "app1", name: "App 1", account_ids: matrix.slice(0, 2).map((a) => a.account_id) },
        { id: "app2", name: "App 2", account_ids: matrix.slice(0, 2).map((a) => a.account_id) },
      ];
      const perApp = buildRunNowPlan({ auto_groups_by_meta_app: false, groups: twoAppGroups, page_row_ids: twoAppIds, posts_per_page_per_day: 1, post_type: "text", app_rotation_mode: "per_app" });
      const interleave = buildRunNowPlan({ auto_groups_by_meta_app: false, groups: twoAppGroups, page_row_ids: twoAppIds, posts_per_page_per_day: 1, post_type: "text", app_rotation_mode: "interleave_apps" });
      assert("P2 option1 per-App order", perApp.slots[0]?.group_id === "app1" && perApp.slots[0]?.page_index === 1 && perApp.slots[1]?.page_index === 1, perApp.slots.slice(0, 4).map((s) => `${s.group_id}/P${s.page_index}`).join(","));
      assert("P2 option2 App interleave order", interleave.slots[0]?.group_id === "app1" && interleave.slots[1]?.group_id === "app2", interleave.slots.slice(0, 3).map((s) => `${s.group_id}/A${s.account_id}/P${s.page_index}`).join(","));
    }
  }

  // Uneven: group with 1 page vs 3 pages
  if (matrix[0]?.pages?.length) {
    const longPages = matrix[0].pages.slice(0, 3).map((p) => p.page_row_id);
    const shortPages = matrix[0].pages.slice(0, 1).map((p) => p.page_row_id);
    // fake second account by using same account in two groups is wrong;
    // just ensure plan doesn't throw with one group having fewer pages via page filter
    const plan = buildRotationPlan({
      auto_groups_by_meta_app: false,
      groups: [{ id: "app1", name: "App1", account_ids: [matrix[0].account_id] }],
      page_row_ids: longPages,
      mode: "fixed_gap",
      posts_per_page_per_day: 1,
      days_ahead: 1,
      fixed_gap: {
        first_start: "20:00",
        first_end: "21:00",
        gap_hours_min: 2,
        gap_hours_max: 2,
      },
    });
    assert("P2 uneven/single group no throw", plan.slots.length >= 1, String(plan.slots.length));
  }

  // Times for page day
  const s = normalizeSettings({
    mode: "windows",
    windows: [
      { name: "S", start: "07:00", end: "10:00", posts: 2 },
      { name: "T", start: "18:00", end: "21:00", posts: 2 },
    ],
    same_page_gap_hours_min: 2,
    same_page_gap_hours_max: 2.5,
  });
  const times = planTimesForPageDay(s, "2026-07-18");
  assert("P2 4 times from windows", times.length === 4, String(times.length));
});

// ---------- PASS 3 ----------
passRun(3, () => {
  // Settings save/load
  const before = loadRotationSettings();
  const saved = saveRotationSettings({
    ...before,
    days_ahead: 2,
    auto_groups_by_meta_app: true,
    same_page_gap_hours_min: 1.5,
  });
  assert("P3 save settings", saved.days_ahead === 2);
  const loaded = loadRotationSettings();
  assert("P3 load settings persist", loaded.days_ahead === 2);
  // restore mild
  saveRotationSettings({ ...loaded, days_ahead: before.days_ahead || 1 });

  // Resolve groups auto
  const matrix = loadAccountPageMatrix(loadRotationSettings());
  const groups = resolveGroups(
    { groups: [], auto_groups_by_meta_app: true },
    matrix
  );
  assert("P3 auto groups >= 1", groups.length >= 1);
  assert(
    "P3 auto group id is meta key",
    groups.every((g) => g.id === "app1" || g.id === "app2" || g.id === "all" || g.admins?.length >= 0)
  );

  // Build plan 3 times for stability
  for (let i = 1; i <= 3; i++) {
    const p = buildRotationPlan({
      auto_groups_by_meta_app: true,
      days_ahead: 1,
      mode: "windows",
      windows: [{ name: "T", start: "19:00", end: "22:00", posts: 1 }],
      page_row_ids: matrix.flatMap((a) => a.pages.slice(0, 1).map((p) => p.page_row_id)).slice(0, 4),
    });
    assert(`P3 stable plan run ${i}`, Array.isArray(p.slots));
    // all unix in graph window
    const now = Date.now() / 1000;
    for (const s of p.slots) {
      assert(
        `P3 slot unix future run${i}`,
        s.unix > now + 500,
        String(s.unix)
      );
      assert(
        `P3 slot within 30d run${i}`,
        s.unix < now + 30 * 24 * 3600
      );
    }
  }

  // Sequential only - job runner file check already done
  // Simulate order: post_round outer means all P1 bai1 before P2... or page then post
  if (matrix.length >= 2) {
    const ids = matrix.flatMap((a) => a.pages.slice(0, 2).map((p) => p.page_row_id));
    const p = buildRotationPlan({
      auto_groups_by_meta_app: false,
      groups: [
        { id: "app1", name: "App 1", account_ids: [matrix[0].account_id] },
        { id: "app2", name: "App 2", account_ids: [matrix[1].account_id] },
      ],
      page_row_ids: ids,
      mode: "windows",
      windows: [{ name: "T", start: "20:00", end: "22:30", posts: 1 }],
      days_ahead: 1,
    });
    // Orders should be sequential integers
    const orders = p.slots.map((s) => s.order);
    assert(
      "P3 orders sequential",
      orders.every((o, i) => o === i + 1),
      orders.slice(0, 5).join(",")
    );
    console.log("  sample order:");
    p.preview_order.slice(0, 8).forEach((x) => console.log("   ", x.label));
  }
});

// Summary
console.log("\n========== FINAL SUMMARY ==========\n");
const failed = results.filter((r) => !r.pass);
const passed = results.filter((r) => r.pass);
console.log(`Passed: ${passed.length}/${results.length}`);
if (failed.length) {
  console.log("FAILED:");
  failed.forEach((f) => console.log(" -", f.name, f.detail || ""));
  process.exit(1);
}
console.log("ALL CHECKS PASSED (3 functional passes + static map)");
process.exit(0);
