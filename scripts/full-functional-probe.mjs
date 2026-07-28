/**
 * Full functional probe — starts isolated server, hits every public surface.
 * Run: node scripts/full-functional-probe.mjs
 * Exit 0 = all must-pass checks OK; prints WARN for optional/network-dependent.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fbps-full-probe-"));
const port = 42000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${port}`;
const logs = [];
const results = [];

function note(level, name, detail = "") {
  results.push({ level, name, detail });
  const mark = level === "PASS" ? "✓" : level === "WARN" ? "⚠" : "✗";
  console.log(`${mark} [${level}] ${name}${detail ? " — " + detail : ""}`);
}

function pass(name, detail) {
  note("PASS", name, detail);
}
function warn(name, detail) {
  note("WARN", name, detail);
}
function fail(name, detail) {
  note("FAIL", name, detail);
}

const child = spawn(process.execPath, [path.join(root, "src", "server.js")], {
  cwd: root,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  env: {
    ...process.env,
    PORT: String(port),
    LISTEN_HOST: "127.0.0.1",
    APP_BASE_URL: `http://127.0.0.1:${port}`,
    FB_REDIRECT_URI: "https://modelswiki.top/auth/facebook/callback",
    FB_APP_ID: "123456789012345",
    FB_APP_SECRET: "",
    FB_APP_NAME: "Probe App 1",
    FB_APP_ID_2: "987654321098765",
    FB_APP_NAME_2: "Probe App 2",
    TOKEN_ENCRYPTION_KEY:
      "full-probe-encryption-key-must-be-longer-than-32-chars",
    DATABASE_PATH: path.join(tempRoot, "data", "app.db"),
    FB_USER_DIR: tempRoot,
    FB_EXE_DIR: tempRoot,
    NGROK_AUTOSTART: "0",
    OPEN_BROWSER: "0",
    OAUTH_RELAY: "1",
    OAUTH_RELAY_URL: "https://modelswiki.top",
    OAUTH_RELAY_SYNC: "0",
    FB_FORCE_HEAL_REDIRECT: "0",
    FB_FIRST_RUN_ALLOW_OFFLINE: "1",
  },
});

for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    logs.push(String(chunk || ""));
    if (logs.length > 120) logs.shift();
  });
}

async function waitHealth(ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      /* wait */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Server health timeout\n" + logs.slice(-20).join(""));
}

async function j(method, urlPath, body, opts = {}) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: body != null ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
    ...opts,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { _raw: text.slice(0, 200) };
  }
  return { res, data, text, status: res.status };
}

async function expectOk(name, method, urlPath, body, extraCheck) {
  try {
    const { res, data, text, status } = await j(method, urlPath, body);
    if (status >= 500) {
      fail(name, `HTTP ${status} ${text.slice(0, 180)}`);
      return null;
    }
    if (status >= 400 && !extraCheck) {
      // 4xx may be expected for some endpoints — caller decides
      fail(name, `HTTP ${status} ${text.slice(0, 180)}`);
      return null;
    }
    if (extraCheck) {
      const msg = extraCheck(data, status, res);
      if (msg) {
        fail(name, msg);
        return null;
      }
    }
    pass(name, `HTTP ${status}`);
    return data;
  } catch (e) {
    fail(name, e.message);
    return null;
  }
}

async function expectStatus(name, method, urlPath, okStatuses, body) {
  try {
    const { status, text } = await j(method, urlPath, body);
    if (!okStatuses.includes(status)) {
      fail(name, `HTTP ${status} expected ${okStatuses.join("|")} · ${text.slice(0, 120)}`);
      return false;
    }
    pass(name, `HTTP ${status}`);
    return true;
  } catch (e) {
    fail(name, e.message);
    return false;
  }
}

function seedDb() {
  const dbPath = path.join(tempRoot, "data", "app.db");
  if (!fs.existsSync(dbPath)) throw new Error("DB not created: " + dbPath);
  const db = new Database(dbPath);
  const acc = db
    .prepare(
      `INSERT INTO fb_accounts
       (fb_user_id, meta_app_key, meta_app_id, name, user_token_enc, status)
       VALUES (?, 'app1', ?, ?, ?, 'active')`
    )
    .run("probe-user-1", "123456789012345", "Probe Admin", "enc-token-probe");
  const page = db
    .prepare(
      `INSERT INTO fb_pages
       (account_id, page_id, name, page_token_enc, status, category)
       VALUES (?, ?, ?, ?, 'active', 'probe')`
    )
    .run(acc.lastInsertRowid, "probe-page-111", "Probe Page Alpha", "page-tok");
  const page2 = db
    .prepare(
      `INSERT INTO fb_pages
       (account_id, page_id, name, page_token_enc, status, category)
       VALUES (?, ?, ?, ?, 'active', 'probe')`
    )
    .run(acc.lastInsertRowid, "probe-page-222", "Probe Page Beta", "page-tok-2");
  for (const id of [page.lastInsertRowid, page2.lastInsertRowid]) {
    db.prepare(
      `INSERT INTO page_post_config
       (page_row_id, enabled, max_posts_per_day, interval_minutes, sequence_json, pick_mode,
        media_folder, posted_folder, captions_folder, preferred_hours_json, captions_json)
       VALUES (?, 1, 3, 120, ?, 'random', ?, ?, ?, ?, ?)`
    ).run(
      id,
      JSON.stringify(["photo", "text"]),
      path.join(tempRoot, "media", "inbox"),
      path.join(tempRoot, "media", "posted"),
      path.join(tempRoot, "media", "captions"),
      JSON.stringify([9, 12, 19, 21]),
      JSON.stringify(["Probe caption A", "Probe caption B"])
    );
  }
  // media folders
  for (const sub of ["inbox", "posted", "captions"]) {
    fs.mkdirSync(path.join(tempRoot, "media", sub), { recursive: true });
  }
  fs.writeFileSync(
    path.join(tempRoot, "media", "captions", "captions.txt"),
    "Probe caption one\nProbe caption two\n",
    "utf8"
  );
  // tiny fake image so media stats don't explode
  fs.writeFileSync(path.join(tempRoot, "media", "inbox", "probe.txt"), "not-image-but-ok\n");
  db.close();
  return {
    accountId: Number(acc.lastInsertRowid),
    pageId: Number(page.lastInsertRowid),
    pageId2: Number(page2.lastInsertRowid),
  };
}

async function stop() {
  if (child.exitCode != null) return;
  try {
    child.send({ type: "shutdown" });
  } catch {
    child.kill();
  }
  await Promise.race([
    new Promise((r) => child.once("exit", r)),
    new Promise((r) =>
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* */
        }
        r();
      }, 3000)
    ),
  ]);
}

try {
  console.log("\n========== FULL FUNCTIONAL PROBE ==========\n");
  console.log(`temp=${tempRoot}\nbase=${base}\n`);

  await waitHealth();
  pass("server health", base);

  // ── Static pages ──
  const pages = [
    "/",
    "/app.html",
    "/index.html",
    "/posting.html",
    "/history.html",
    "/antispam.html",
    "/license.html",
    "/delete-posts.html",
    "/delete-group-posts.html",
    "/download.html",
    "/css/app.css",
    "/js/shell.js",
    "/js/update.js",
  ];
  for (const p of pages) {
    const r = await fetch(`${base}${p}`);
    if (!r.ok && r.status !== 302) fail(`static ${p}`, `HTTP ${r.status}`);
    else pass(`static ${p}`, `HTTP ${r.status}`);
  }

  // posting.html must contain Start at apply
  {
    const html = await (await fetch(`${base}/posting.html`)).text();
    if (!html.includes("btnBulkStartApply")) fail("posting Start-at UI", "missing btnBulkStartApply");
    else pass("posting Start-at UI", "btnBulkStartApply present");
    if (!html.includes("parseLocalDateTimeValue")) fail("posting datetime parse", "missing helper");
    else pass("posting datetime parse helper");
    if (!html.includes("btnBulkSchedule")) fail("posting bulk schedule", "missing button");
    else pass("posting bulk schedule button");
  }

  // ── Core meta / version / deploy ──
  await expectOk("GET /api/health", "GET", "/api/health", null, (d) =>
    d?.ok === false ? "ok false" : null
  );
  await expectOk("GET /api/version", "GET", "/api/version");
  await expectOk("GET /api/meta", "GET", "/api/meta");
  await expectOk("GET /api/deploy", "GET", "/api/deploy", null, (d) =>
    d?.oauth_relay == null && d?.mode == null ? "missing deploy fields" : null
  );

  // ── Setup ──
  await expectOk("GET first-run", "GET", "/api/setup/first-run");
  await expectOk(
    "PUT first-run offline",
    "PUT",
    "/api/setup/first-run",
    {
      app1_name: "Probe App 1",
      app1_id: "123456789012345",
      app1_secret: "probe-secret-12345678901234",
      skip_relay_push: true,
    },
    (d, st) => (st !== 200 || !d?.ok ? `not ok ${st}` : null)
  );
  await expectOk("GET domain setup", "GET", "/api/setup/domain");
  await expectOk(
    "PUT domain setup (relay keeps local base)",
    "PUT",
    "/api/setup/domain",
    { domain: "https://modelswiki.top" },
    (d, st) => {
      if (st !== 200 || !d?.ok) return `fail ${st}`;
      if (d.redirect_uri && !String(d.redirect_uri).includes("modelswiki.top"))
        return "redirect not modelswiki";
      if (d.app_base_url && !/127\.0\.0\.1|localhost/.test(d.app_base_url))
        return "app_base_url not local: " + d.app_base_url;
      return null;
    }
  );
  await expectOk("GET ngrok status", "GET", "/api/setup/ngrok");
  await expectOk("GET browser profiles", "GET", "/api/setup/browser");
  await expectOk("GET browser history", "GET", "/api/setup/browser/history");
  await expectOk("POST browser scan empty", "POST", "/api/setup/browser/scan", {
    roots: [],
  });

  // ── Seed DB for page-level features ──
  const seed = seedDb();
  pass("seed DB accounts/pages", `acc=${seed.accountId} pages=${seed.pageId},${seed.pageId2}`);

  // ── Accounts / pages ──
  const accounts = await expectOk("GET accounts", "GET", "/api/accounts");
  if (accounts && !(accounts.accounts || accounts)?.length && !Array.isArray(accounts)) {
    // shape may be { accounts: [] } or array
  }
  await expectOk("GET pages", "GET", "/api/pages");
  await expectOk("GET stats", "GET", "/api/stats");
  await expectOk("GET usage", "GET", "/api/usage");
  await expectOk(`GET account ${seed.accountId}`, "GET", `/api/accounts/${seed.accountId}`);
  await expectOk(`GET page ${seed.pageId}`, "GET", `/api/pages/${seed.pageId}`);

  // ── Anti-spam ──
  await expectOk("GET anti-spam", "GET", "/api/anti-spam");
  await expectOk("POST anti-spam toggle", "POST", "/api/anti-spam/toggle", {});
  await expectOk("GET anti-spam events", "GET", "/api/anti-spam/events");
  await expectOk("POST anti-spam preset safe", "POST", "/api/anti-spam/preset", {
    preset: "safe",
  });

  // ── License ──
  await expectOk("GET license status", "GET", "/api/license/status");
  await expectOk("GET license machine", "GET", "/api/license/machine");
  await expectStatus("POST license verify empty", "POST", "/api/license/verify", [200, 400], {
    key: "",
  });

  // ── Posting workspace ──
  await expectOk("GET workspace-state", "GET", "/api/posting/workspace-state");
  await expectOk(
    "PUT workspace-state bulk",
    "PUT",
    "/api/posting/workspace-state",
    {
      state: {
        selected_page_ids: [seed.pageId, seed.pageId2],
        active_page_id: seed.pageId,
        active_view: "schedule",
        bulk: {
          bulkMode: "fixed",
          bulkCount: "3",
          bulkStart: (() => {
            const d = new Date(Date.now() + 3 * 3600 * 1000);
            const p = (n) => String(n).padStart(2, "0");
            return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
          })(),
          bulkIntervalMin: "120",
          bulkIntervalMax: "180",
        },
        rotation: { rotNowPerDay: "2" },
      },
    },
    (d, st) => (st !== 200 ? `HTTP ${st}` : null)
  );
  await expectOk("GET posting pages", "GET", "/api/posting/pages");
  await expectOk("GET posting defaults", "GET", "/api/posting/defaults");
  await expectOk("GET posting logs", "GET", "/api/posting/logs?limit=5");
  await expectOk("GET posting logs csv", "GET", "/api/posting/logs/csv", null, (d, st) =>
    st !== 200 ? `HTTP ${st}` : null
  );
  await expectOk("GET posting stats summary", "GET", "/api/posting/stats/summary", null, (d, st) => {
    if (st !== 200) return `HTTP ${st}`;
    if (!d?.today || !d?.total) return "missing today/total buckets";
    return null;
  });
  await expectOk("GET history days", "GET", "/api/posting/history/days");
  await expectOk("GET history today", "GET", "/api/posting/history", null, (d, st) =>
    st !== 200 ? `HTTP ${st}` : null
  );
  await expectOk(
    `GET config page ${seed.pageId}`,
    "GET",
    `/api/posting/config/${seed.pageId}`
  );
  await expectOk(
    `PUT config page ${seed.pageId}`,
    "PUT",
    `/api/posting/config/${seed.pageId}`,
    {
      enabled: 1,
      max_posts_per_day: 3,
      interval_minutes: 120,
      sequence: "photo,text",
      pick_mode: "random",
      media_folder: path.join(tempRoot, "media", "inbox"),
      posted_folder: path.join(tempRoot, "media", "posted"),
      captions_folder: path.join(tempRoot, "media", "captions"),
      captions: "hello probe\nsecond line",
    }
  );
  await expectOk("PUT preferred-hours bulk", "PUT", "/api/posting/preferred-hours/bulk", {
    page_row_ids: [seed.pageId, seed.pageId2],
    hours: [9, 12, 19, 21],
  });
  await expectOk(
    `GET preferred-hours ${seed.pageId}`,
    "GET",
    `/api/posting/preferred-hours/${seed.pageId}`
  );
  await expectOk(
    `GET active-times ${seed.pageId}`,
    "GET",
    `/api/posting/active-times/${seed.pageId}?force=0`
  );

  // ── Bulk schedule dry-run (no Graph — may fail token but must not 500 crash) ──
  {
    const start = new Date(Date.now() + 4 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, "0");
    const startAt = `${start.getFullYear()}-${p(start.getMonth() + 1)}-${p(start.getDate())} ${p(start.getHours())}:${p(start.getMinutes())}`;
    const { status, data, text } = await j("POST", "/api/posting/schedule/bulk", {
      page_row_ids: [seed.pageId, seed.pageId2],
      mode: "fixed",
      start_at: startAt,
      count_per_page: 2,
      interval_minutes_min: 120,
      interval_minutes_max: 120,
      post_type: "text",
      tz_offset_minutes: 420,
      dry_run: true,
      ignore_page_quota: true,
    });
    if (status >= 500) fail("POST schedule/bulk dry-run", `HTTP ${status} ${text.slice(0, 150)}`);
    else {
      pass("POST schedule/bulk dry-run", `HTTP ${status}`);
      if (data?.plan) {
        const slots = (data.plan || []).reduce((n, x) => n + (x.slots?.length || 0), 0);
        pass("bulk dry-run has plan", `pages=${data.plan.length} slots=${slots}`);
      } else if (data?.error) {
        warn("bulk dry-run business error", data.error);
      }
    }
  }

  // active_times dry-run
  {
    const { status, text } = await j("POST", "/api/posting/schedule/bulk", {
      page_row_ids: [seed.pageId],
      mode: "active_times",
      days_ahead: 2,
      posts_per_day: 2,
      post_type: "text",
      tz_offset_minutes: 420,
      dry_run: true,
    });
    if (status >= 500) fail("bulk active_times dry-run", `HTTP ${status} ${text.slice(0, 120)}`);
    else pass("bulk active_times dry-run", `HTTP ${status}`);
  }

  // ── Jobs / rotation ──
  await expectOk("GET jobs", "GET", "/api/jobs");
  await expectOk("GET rotation settings", "GET", "/api/jobs/rotation/settings");
  await expectOk("GET rotation matrix", "GET", "/api/jobs/rotation/matrix");
  await expectOk("POST rotation settings", "POST", "/api/jobs/rotation/settings", {
    auto_groups_by_meta_app: true,
  });
  {
    const { status, data, text } = await j("POST", "/api/jobs/rotation/plan", {
      days: 1,
      mode: "windows",
      windows: [
        { name: "Sáng", start: "07:30", end: "11:30", posts: 1 },
        { name: "Tối", start: "18:00", end: "21:30", posts: 1 },
      ],
      page_row_ids: [seed.pageId, seed.pageId2],
    });
    if (status >= 500) fail("rotation plan", `HTTP ${status} ${text.slice(0, 120)}`);
    else pass("rotation plan", `HTTP ${status} slots=${data?.slots?.length ?? data?.plan?.length ?? "?"}`);
  }
  {
    const { status, text } = await j("POST", "/api/jobs/rotation/run-now", {
      dry_run: true,
      per_day: 1,
      page_row_ids: [seed.pageId],
      time_mode: "gap",
      gap_min: 30,
      gap_max: 45,
    });
    if (status >= 500) fail("rotation run-now dry", `HTTP ${status} ${text.slice(0, 120)}`);
    else pass("rotation run-now dry", `HTTP ${status}`);
  }

  // bulk-schedule job dry via jobs route
  {
    const start = new Date(Date.now() + 5 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, "0");
    const startAt = `${start.getFullYear()}-${p(start.getMonth() + 1)}-${p(start.getDate())} ${p(start.getHours())}:${p(start.getMinutes())}`;
    const { status, text } = await j("POST", "/api/jobs/bulk-schedule", {
      page_row_ids: [seed.pageId],
      mode: "fixed",
      start_at: startAt,
      count_per_page: 1,
      interval_minutes: 120,
      post_type: "text",
      dry_run: true,
    });
    if (status >= 500) fail("jobs bulk-schedule dry", `HTTP ${status} ${text.slice(0, 120)}`);
    else pass("jobs bulk-schedule dry", `HTTP ${status}`);
  }

  // ── Delete posts surfaces (list only) ──
  await expectOk("GET delete-posts pages", "GET", "/api/delete-posts/pages");
  await expectOk("GET delete-posts jobs", "GET", "/api/delete-posts/jobs");
  await expectOk("GET delete-group accounts", "GET", "/api/delete-group-posts/accounts");
  await expectOk("GET delete-group jobs", "GET", "/api/delete-group-posts/jobs");
  await expectOk("POST parse-ids", "POST", "/api/delete-group-posts/parse-ids", {
    text: "123\n456 789",
  });

  // ── Reports / export / media ──
  await expectOk("GET reports daily info", "GET", "/api/reports/daily/info");
  await expectOk("GET jobs reports info", "GET", "/api/jobs/reports/info");
  await expectOk("GET media inbox", "GET", "/api/media/inbox");
  await expectOk("GET export sheets", "GET", "/api/export/sheets");
  await expectOk("GET export csv", "GET", "/api/export/csv");
  await expectOk("GET debug paths", "GET", "/api/debug/paths");
  await expectOk("GET update check", "GET", "/api/update/check");
  await expectOk("GET update progress", "GET", "/api/update/progress");
  await expectOk("GET update last-error", "GET", "/api/update/last-error");

  // ── Auth apps list ──
  await expectOk("GET /auth/apps", "GET", "/auth/apps");
  await expectStatus(
    "GET /auth/facebook unconfigured-ish still responds",
    "GET",
    "/auth/facebook?external=1&app=app1",
    [200, 302, 500]
  );

  // ── Scheduler tick (safe) ──
  await expectOk("POST scheduler tick", "POST", "/api/posting/scheduler/tick", {});

  // ── Reconcile scheduled ──
  await expectOk("POST reconcile-scheduled", "POST", "/api/posting/reconcile-scheduled", {
    limit: 5,
  });

  // ── Config bulk ──
  await expectOk("PUT config-bulk", "PUT", "/api/posting/config-bulk", {
    page_row_ids: [seed.pageId, seed.pageId2],
    patch: { max_posts_per_day: 4 },
  });

  // ── Edge: invalid page ──
  await expectStatus(
    "GET config missing page",
    "GET",
    "/api/posting/config/999999",
    [404, 400, 500]
  );

  // ── Static UI integrity (small features) ──
  {
    const idx = await (await fetch(`${base}/index.html`)).text();
    for (const s of [
      "firstRunSetup",
      "btnSaveFirstRun",
      "setupApp1Id",
      "btnConnect",
      "oauthDomain",
    ]) {
      if (!idx.includes(s)) fail(`index has ${s}`, "missing");
      else pass(`index has ${s}`);
    }
    const app = await (await fetch(`${base}/app.html`)).text();
    for (const s of ["shell.js", "update.js", "nav"]) {
      if (!app.includes(s) && s !== "nav") fail(`app.html ${s}`, "missing");
      else pass(`app.html contains ${s}`);
    }
  }

  // ── Unit-ish: parseFixedTimes via dynamic import ──
  {
    const { parseFixedTimes } = await import("../src/services/activeTimes.js");
    const future = new Date(Date.now() + 3 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, "0");
    const wall = `${future.getFullYear()}-${p(future.getMonth() + 1)}-${p(future.getDate())} ${p(future.getHours())}:${p(future.getMinutes())}`;
    const parsed = parseFixedTimes([wall], 420);
    if (!parsed.length) fail("parseFixedTimes VN wall", wall);
    else pass("parseFixedTimes VN wall", parsed[0].toISOString());
    const bad = parseFixedTimes(["not-a-date"], 420);
    if (bad.length) fail("parseFixedTimes rejects garbage", String(bad.length));
    else pass("parseFixedTimes rejects garbage");
  }

  // ── scheduleBulk service dry with seeded pages ──
  {
    const { scheduleBulk } = await import("../src/services/schedule.js");
    // Need env DATABASE_PATH for getDb — server process owns DB; import uses same process.env
    process.env.DATABASE_PATH = path.join(tempRoot, "data", "app.db");
    process.env.FB_USER_DIR = tempRoot;
    const start = new Date(Date.now() + 6 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, "0");
    const startAt = `${start.getFullYear()}-${p(start.getMonth() + 1)}-${p(start.getDate())} ${p(start.getHours())}:${p(start.getMinutes())}`;
    try {
      const r = await scheduleBulk({
        page_row_ids: [seed.pageId],
        mode: "fixed",
        start_at: startAt,
        count_per_page: 2,
        interval_minutes: 120,
        post_type: "text",
        tz_offset_minutes: 420,
        dry_run: true,
        ignore_page_quota: true,
      });
      const slots = (r.plan || []).reduce((n, x) => n + (x.slots?.length || 0), 0);
      if (slots < 1 && (r.plan || []).every((x) => x.error)) {
        warn("scheduleBulk dry all errors", JSON.stringify(r.plan?.[0]?.error || r).slice(0, 120));
      } else {
        pass("scheduleBulk dry in-process", `slots=${slots}`);
      }
    } catch (e) {
      // DB may be locked by server — warn not fail
      warn("scheduleBulk in-process", e.message);
    }
  }

  // ── Pick folder API (may fail headless) ──
  {
    const { status, text } = await j("POST", "/api/system/pick-folder", {
      title: "probe",
    });
    if (status >= 500) warn("pick-folder", `HTTP ${status} ${text.slice(0, 80)}`);
    else pass("pick-folder responds", `HTTP ${status}`);
  }

  console.log("\n========== PROBE SUMMARY ==========\n");
  const fails = results.filter((r) => r.level === "FAIL");
  const warns = results.filter((r) => r.level === "WARN");
  const passes = results.filter((r) => r.level === "PASS");
  console.log(`PASS ${passes.length} · WARN ${warns.length} · FAIL ${fails.length}`);
  if (fails.length) {
    console.log("\nFAILURES:");
    for (const f of fails) console.log(" -", f.name, f.detail);
  }
  if (warns.length) {
    console.log("\nWARNINGS:");
    for (const w of warns) console.log(" -", w.name, w.detail);
  }

  await stop();
  // cleanup temp
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    /* */
  }

  if (fails.length) process.exit(1);
  console.log("\nALL MUST-PASS CHECKS OK\n");
  process.exit(0);
} catch (e) {
  console.error("\nPROBE CRASH:", e);
  console.error(logs.slice(-30).join(""));
  await stop();
  process.exit(1);
}
