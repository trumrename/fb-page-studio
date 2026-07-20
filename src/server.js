import express from "express";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { config } from "./config.js";
import { getPublicDir, getExeDir, getEnvPath, isPackaged } from "./paths.js";
import { getDb } from "./db/index.js";
import authRoutes from "./routes/auth.js";
import apiRoutes from "./routes/api.js";
import postingRoutes from "./routes/posting.js";
import jobsRoutes from "./routes/jobs.js";
import licenseRoutes from "./routes/license.js";
import { runSchedulerTick, getPagePostConfig, mediaStats, getCaptionStats } from "./services/poster.js";
import { reconcileScheduledLogs } from "./services/schedule.js";
import { exportAllDailyReports, exportPostingHistoryDaily, vnDay, yesterdayVn } from "./services/dailyReports.js";
import { enrichAllPages } from "./services/enrich.js";
import { ensureAntiSpamTables } from "./services/antiSpam.js";
import {
  getLicenseStatus,
  ensureLicenseAfterUpdate,
} from "./services/license.js";
import {
  startNgrok,
  stopNgrok,
  ensureNgrokTokenFromSystem,
} from "./services/ngrokManager.js";

const app = express();
const publicDir = getPublicDir();

// Init DB + default media folders + anti-spam
getDb();
ensureAntiSpamTables();
// Re-load license after update (data/license.json survives .exe replace)
try {
  ensureLicenseAfterUpdate();
} catch (e) {
  console.warn("[license] ensure after update:", e.message);
}
// Admin/dev machines often have token only in system ngrok.yml
try {
  ensureNgrokTokenFromSystem();
} catch (e) {
  console.warn("[ngrok] bootstrap token:", e.message);
}
const dataRoot = config.dataDir || path.dirname(config.databasePath);
fs.mkdirSync(path.join(dataRoot, "media", "inbox"), { recursive: true });
fs.mkdirSync(path.join(dataRoot, "media", "posted"), { recursive: true });
fs.mkdirSync(path.join(dataRoot, "media", "captions"), { recursive: true });
const sampleCap = path.join(dataRoot, "media", "captions", "captions.txt");
if (!fs.existsSync(sampleCap)) {
  fs.writeFileSync(
    sampleCap,
    [
      "# Mỗi dòng = 1 caption. Dòng bắt đầu # bị bỏ qua.",
      "# Tool lấy caption lần lượt đến hết, sau đó trộn và xoay vòng.",
      "Good morning! New update today.",
      "Don't miss this one.",
      "Full vibe on the page today.",
      "",
    ].join("\n"),
    "utf8"
  );
}
const sampleCsv = path.join(dataRoot, "media", "captions", "captions.csv");
if (!fs.existsSync(sampleCsv)) {
  fs.writeFileSync(
    sampleCsv,
    "caption\nAnother caption from CSV file\nThird caption from CSV\n",
    "utf8"
  );
}

// Seed .env.example next to exe if missing (never overwrite secrets)
const envBeside = path.join(getExeDir(), ".env");
const exampleBeside = path.join(getExeDir(), ".env.example");
if (!fs.existsSync(exampleBeside)) {
  try {
    const sample = [
      "PORT=3847",
      "APP_BASE_URL=http://localhost:3847",
      "FB_APP_ID=",
      "FB_APP_SECRET=",
      "FB_APP_NAME=App 1",
      "FB_REDIRECT_URI=http://localhost:3847/auth/facebook/callback",
      "# App 2 (optional — Connect /auth/facebook?app=app2)",
      "FB_APP_ID_2=",
      "FB_APP_SECRET_2=",
      "FB_APP_NAME_2=App 2",
      "# FB_REDIRECT_URI_2=  (empty = same as App 1; register URI on BOTH Meta apps)",
      "FB_GRAPH_VERSION=v21.0",
      "NGROK_AUTHTOKEN=",
      "NGROK_AUTOSTART=1",
      "FB_SCOPES=pages_show_list,pages_manage_posts,pages_read_engagement,pages_manage_engagement,read_insights,public_profile",
      "TOKEN_ENCRYPTION_KEY=change-me-to-a-long-random-string-32+",
      "GITHUB_REPO=trumrename/fb-page-studio",
      "UPDATE_ASSET=FB-Page-Studio-Desktop.exe",
      "# Optional: full path to browser for OAuth (default: Chrome then Edge)",
      "# BROWSER_PATH=C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe",
      "# FB_CHROME_PROFILE=Profile 1  (chọn profile đã login Facebook)",
      "",
    ].join("\n");
    fs.writeFileSync(exampleBeside, sample, "utf8");
  } catch {
    /* ignore */
  }
}

app.use(express.json({ limit: "10mb" }));

// Ngrok is needed only for the Facebook OAuth callback. Never expose the
// local dashboard or mutation APIs through the public tunnel by default.
app.use((req, res, next) => {
  const rawHost = String(req.headers["x-forwarded-host"] || req.headers.host || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const host = rawHost.startsWith("[")
    ? rawHost.slice(1, rawHost.indexOf("]"))
    : rawHost.split(":")[0];
  const isLocalHost = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const cameThroughProxy = Boolean(
    req.headers["x-forwarded-for"] ||
      req.headers["x-forwarded-host"] ||
      req.headers["x-original-host"]
  );
  const isFacebookCallback =
    req.method === "GET" && req.path === "/auth/facebook/callback";
  if ((isLocalHost && !cameThroughProxy) || isFacebookCallback) return next();
  return res
    .status(403)
    .type("text/plain; charset=utf-8")
    .send("FB Page Studio chỉ cho phép OAuth callback qua domain công khai. Hãy mở giao diện bằng 127.0.0.1.");
});

// App console is the main entry (before static index.html)
app.get("/", (_req, res) => {
  res.redirect(302, "/app.html");
});

app.get("/api/meta", (_req, res) => {
  const lic = getLicenseStatus();
  res.json({
    name: "fb-page-studio",
    version: config.version,
    phase: "multi-app + rotation + license",
    packaged: isPackaged(),
    note: "Story flag optional. Official Graph API only.",
    license: {
      mode: lic.mode,
      active: lic.active,
      label: lic.label,
      expires_at: lic.expires_at || null,
    },
  });
});

app.use("/auth", authRoutes);
app.use("/api/license", licenseRoutes);
app.use("/api", apiRoutes);
app.use("/api/posting", postingRoutes);
app.use("/api/jobs", jobsRoutes);
app.use(express.static(publicDir));

// Startup: log if GitHub has a newer release (non-blocking)
import("./services/updater.js")
  .then(({ checkForUpdate }) => checkForUpdate())
  .then((r) => {
    if (r?.ok && r.has_update) {
      console.log(
        `[update] Có bản mới v${r.latest_version} (hiện v${r.current_version})` +
          (r.asset ? ` · ${r.asset.name}` : " · ⚠ release chưa có .exe") +
          (r.release_url ? ` · ${r.release_url}` : "")
      );
    } else if (r?.ok) {
      console.log(`[update] Đang là bản mới nhất v${r.current_version}`);
    } else if (r?.error) {
      console.warn(`[update] Check: ${r.error}`);
    }
  })
  .catch((e) => console.warn("[update]", e.message));

// Scheduler: every 60s check enabled pages
const SCHEDULER_MS = Number(process.env.SCHEDULER_INTERVAL_MS || 60000);
let schedulerRunning = false;
const schedulerState = {
  enabled: true,
  interval_ms: SCHEDULER_MS,
  running: false,
  tick_count: 0,
  last_started_at: null,
  last_finished_at: null,
  next_tick_at: new Date(Date.now() + SCHEDULER_MS).toISOString(),
  last_error: null,
  last_summary: { checked: 0, posted: 0, skipped: 0, failed: 0 },
};

app.get("/api/runtime", (_req, res) => {
  let enabledPages = 0;
  let configHealth = { total_pages: 0, custom_config_pages: 0, default_config_pages: 0, valid_folder_pages: 0, ready_pages: 0, pages_without_media: 0, pages_without_captions: 0 };
  try {
    const db = getDb();
    enabledPages = db
      .prepare("SELECT COUNT(*) AS n FROM page_post_config c JOIN fb_pages p ON p.id=c.page_row_id WHERE c.enabled=1 AND p.status='active'")
      .get()?.n || 0;
    const rows = db.prepare(`SELECT p.id, c.page_row_id AS has_custom_config
      FROM fb_pages p LEFT JOIN page_post_config c ON c.page_row_id=p.id WHERE p.status='active'`).all();
    configHealth.total_pages = rows.length;
    const mediaCache = new Map();
    const captionCache = new Map();
    for (const row of rows) {
      row.has_custom_config ? configHealth.custom_config_pages++ : configHealth.default_config_pages++;
      const cfg = getPagePostConfig(row.id);
      const foldersOk = [cfg.media_folder, cfg.captions_folder, cfg.posted_folder].every((p) => p && fs.existsSync(p));
      if (foldersOk) configHealth.valid_folder_pages++;
      if (!mediaCache.has(cfg.media_folder)) mediaCache.set(cfg.media_folder, mediaStats(cfg.media_folder));
      if (!captionCache.has(cfg.captions_folder)) captionCache.set(cfg.captions_folder, getCaptionStats(cfg));
      const media = mediaCache.get(cfg.media_folder);
      const captions = captionCache.get(cfg.captions_folder);
      const hasMedia = Number(media?.photos || 0) + Number(media?.videos || 0) > 0;
      const hasCaptions = Number(captions?.total || 0) > 0;
      if (!hasMedia) configHealth.pages_without_media++;
      if (!hasCaptions) configHealth.pages_without_captions++;
      if (foldersOk && hasMedia && hasCaptions) configHealth.ready_pages++;
    }
  } catch {}
  res.json({
    ok: true,
    server_time: new Date().toISOString(),
    scheduler: { ...schedulerState, enabled_pages: enabledPages },
    config_health: configHealth,
  });
});

setInterval(() => {
  schedulerState.next_tick_at = new Date(Date.now() + SCHEDULER_MS).toISOString();
  if (schedulerRunning) {
    console.warn("[scheduler] Bỏ qua tick vì lượt trước vẫn đang chạy");
    return;
  }
  schedulerRunning = true;
  schedulerState.running = true;
  schedulerState.last_started_at = new Date().toISOString();
  schedulerState.last_error = null;
  runSchedulerTick()
    .then((results) => {
      const posted = results.filter((r) => r.ok);
      schedulerState.tick_count++;
      schedulerState.last_summary = {
        checked: results.length,
        posted: posted.length,
        skipped: results.filter((r) => r.skipped).length,
        failed: results.filter((r) => !r.ok && !r.skipped).length,
      };
      if (posted.length) {
        console.log(
          `[scheduler] posted ${posted.length}:`,
          posted.map((p) => p.post_type || p.page_row_id).join(", ")
        );
      }
    })
    .catch((e) => {
      schedulerState.last_error = e.message;
      console.error("[scheduler]", e.message);
    })
    .finally(() => {
      schedulerRunning = false;
      schedulerState.running = false;
      schedulerState.last_finished_at = new Date().toISOString();
    });
}, SCHEDULER_MS);

// Reconcile schedules that have passed their publish time with Facebook.
const RECONCILE_MS = 5 * 60 * 1000;
let reconcileRunning = false;
async function runScheduledReconcile() {
  if (reconcileRunning) return;
  reconcileRunning = true;
  try {
    const r = await reconcileScheduledLogs({ limit: 50 });
    if (r.checked) {
      console.log(`[reconcile] checked ${r.checked} · published ${r.published} · overdue ${r.overdue} · unknown ${r.unknown}`);
    }
  } catch (e) {
    console.warn("[reconcile]", e.message);
  } finally {
    reconcileRunning = false;
  }
}
setTimeout(runScheduledReconcile, 15000);
setInterval(runScheduledReconcile, RECONCILE_MS);

// Daily CSV + cumulative Excel sheets at 23:59 Vietnam time.
let lastDailyExportDay = null;
async function runEndOfDayExport(day, reason) {
  try {
    const followerSync = await enrichAllPages({ force: true });
    const r = await exportAllDailyReports({ day });
    lastDailyExportDay = day;
    console.log(`[daily-report] ${reason} ${day} · follower accounts ${followerSync.accounts} · page files ${r.pages.files.length} · history rows ${r.history.rows}`);
  } catch (e) {
    console.warn("[daily-report]", e.message);
  }
}
function dailyReportTick() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
  const day = vnDay(now);
  if (hour === 23 && minute === 59 && lastDailyExportDay !== day) {
    runEndOfDayExport(day, "23:59 VN");
  }
}
setTimeout(async () => {
  try {
    const r = await exportPostingHistoryDaily({ day: yesterdayVn() });
    console.log(`[daily-report] startup history catch-up ${r.day} · ${r.rows} rows`);
  } catch (e) {
    console.warn("[daily-report] startup catch-up", e.message);
  }
}, 20000);
setInterval(dailyReportTick, 30000);

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch (e) {
    console.warn("[open browser]", e.message);
  }
}

// Bind IPv4 only — ngrok on Windows often dials [::1] for "localhost" and fails
// with ERR_NGROK_8012 if the app only works on 127.0.0.1 (or nothing is listening).
const LISTEN_HOST = process.env.LISTEN_HOST || "127.0.0.1";
const server = app.listen(config.port, LISTEN_HOST, () => {
  const local = `http://127.0.0.1:${config.port}`;
  console.log(`\n  FB Page Studio  v${config.version}`);
  console.log(`  APP CONSOLE    →  ${local}/app.html`);
  console.log(`  Listen         →  ${LISTEN_HOST}:${config.port}`);
  console.log(`  Public base    →  ${config.appBaseUrl}`);
  console.log(`  Reports        →  ${path.join(dataRoot, "exports")}`);
  console.log(`  Data folder    →  ${dataRoot}`);
  console.log(`  .env           →  ${getEnvPath()}`);
  console.log(`  Media inbox    →  ${path.join(dataRoot, "media", "inbox")}`);
  console.log(`  Scheduler      →  every ${SCHEDULER_MS / 1000}s`);
  console.log(`  Graph version  →  ${config.facebook.graphVersion}`);
  console.log(
    `  App configured →  ${config.facebook.appId ? "yes" : "NO — set .env"}\n`
  );
  console.log(
    `  Ngrok tip      →  ngrok http 127.0.0.1:${config.port}  (giữ app MỞ khi login FB)\n`
  );
  if (String(process.env.NGROK_AUTOSTART || "1") !== "0") {
    startNgrok({ origin: config.appBaseUrl, port: config.port })
      .then((s) => console.log(`[ngrok] ${s.status} · ${s.message}${s.public_url ? ` · ${s.public_url}` : ""}`))
      .catch((e) => console.warn("[ngrok]", e.message));
  }

  // Desktop (Electron) never opens external browser
  if (
    process.env.OPEN_BROWSER !== "0" &&
    !process.env.ELECTRON_RUN &&
    !process.versions?.electron
  ) {
    openBrowser(`${local}/app.html`);
  }
});

let shuttingDown = false;
function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopNgrok().finally(() => process.exit(0));
}
process.once("SIGTERM", gracefulShutdown);
process.once("SIGINT", gracefulShutdown);
process.on("message", (msg) => {
  if (msg?.type === "shutdown") gracefulShutdown();
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n  Port ${config.port} đang bận. Đổi PORT trong .env hoặc tắt process cũ.\n`
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});
