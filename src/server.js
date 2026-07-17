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
import { runSchedulerTick } from "./services/poster.js";

const app = express();
const publicDir = getPublicDir();

// Init DB + default media folders
getDb();
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
      "FB_REDIRECT_URI=http://localhost:3847/auth/facebook/callback",
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
app.use(express.static(publicDir));

app.use("/auth", authRoutes);
app.use("/api", apiRoutes);
app.use("/api/posting", postingRoutes);

app.get("/api", (_req, res) => {
  res.json({
    name: "fb-page-studio",
    version: config.version,
    phase: "2 — feed posting + schedule + portable exe",
    packaged: isPackaged(),
    note: "Story flag optional. Official Graph API only.",
  });
});

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
  console.log(`  UI             →  ${local}`);
  console.log(`  Public base    →  ${config.appBaseUrl}`);
  console.log(`  Posting        →  ${local}/posting.html`);
  console.log(`  Data folder    →  ${dataRoot}`);
  console.log(`  .env           →  ${getEnvPath()}`);
  console.log(`  Media inbox    →  ${path.join(dataRoot, "media", "inbox")}`);
  console.log(`  Scheduler      →  every ${SCHEDULER_MS / 1000}s`);
  console.log(`  Graph version  →  ${config.facebook.graphVersion}`);
  console.log(
    `  App configured →  ${config.facebook.appId ? "yes" : "NO — set .env"}\n`
  );

  if (process.env.OPEN_BROWSER !== "0") {
    openBrowser(local);
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
