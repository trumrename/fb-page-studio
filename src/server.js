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
import { runSchedulerTick } from "./services/poster.js";
import { ensureAntiSpamTables } from "./services/antiSpam.js";
import { getLicenseStatus } from "./services/license.js";

const app = express();
const publicDir = getPublicDir();

// Init DB + default media folders + anti-spam
getDb();
ensureAntiSpamTables();
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
      "# Tool random 1 dòng khi đăng (pick_mode=random).",
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
      "FB_SCOPES=pages_show_list,pages_manage_posts,pages_read_engagement,pages_manage_engagement,read_insights,public_profile",
      "TOKEN_ENCRYPTION_KEY=change-me-to-a-long-random-string-32+",
      "GITHUB_REPO=your-github-user/fb-page-studio",
      "",
    ].join("\n");
    fs.writeFileSync(exampleBeside, sample, "utf8");
  } catch {
    /* ignore */
  }
}

app.use(express.json({ limit: "10mb" }));

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

// Scheduler: every 60s check enabled pages
const SCHEDULER_MS = Number(process.env.SCHEDULER_INTERVAL_MS || 60000);
setInterval(() => {
  runSchedulerTick()
    .then((results) => {
      const posted = results.filter((r) => r.ok);
      if (posted.length) {
        console.log(
          `[scheduler] posted ${posted.length}:`,
          posted.map((p) => p.post_type || p.page_row_id).join(", ")
        );
      }
    })
    .catch((e) => console.error("[scheduler]", e.message));
}, SCHEDULER_MS);

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

const server = app.listen(config.port, () => {
  const local = `http://localhost:${config.port}`;
  console.log(`\n  FB Page Studio  v${config.version}`);
  console.log(`  APP CONSOLE    →  ${local}/app.html`);
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

  // Desktop (Electron) never opens external browser
  if (
    process.env.OPEN_BROWSER !== "0" &&
    !process.env.ELECTRON_RUN &&
    !process.versions?.electron
  ) {
    openBrowser(`${local}/app.html`);
  }
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
