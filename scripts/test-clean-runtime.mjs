import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fbps-clean-runtime-"));
const port = 41000 + Math.floor(Math.random() * 1500);
const base = "http://127.0.0.1:" + port;
const output = [];

const child = spawn(process.execPath, [path.join(root, "src", "server.js")], {
  cwd: root,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  env: {
    ...process.env,
    PORT: String(port),
    LISTEN_HOST: "127.0.0.1",
    APP_BASE_URL: "https://clean-runtime.invalid",
    FB_REDIRECT_URI:
      "https://clean-runtime.invalid/auth/facebook/callback",
    FB_APP_ID: "",
    FB_APP_SECRET: "",
    FB_APP_NAME: "Clean Runtime App",
    FB_APP_ID_2: "",
    FB_APP_SECRET_2: "",
    TOKEN_ENCRYPTION_KEY:
      "clean-runtime-encryption-key-longer-than-32-characters",
    DATABASE_PATH: path.join(tempRoot, "data", "app.db"),
    FB_USER_DIR: tempRoot,
    FB_EXE_DIR: tempRoot,
    NGROK_AUTOSTART: "0",
    OPEN_BROWSER: "0",
  },
});

for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    output.push(String(chunk || ""));
    if (output.length > 80) output.shift();
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base + "/api/health");
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Clean runtime did not start in 25 seconds.");
}

async function stopChild() {
  if (child.exitCode != null) return;
  try {
    child.send({ type: "shutdown" });
  } catch {
    child.kill();
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) =>
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          // Process already stopped.
        }
        resolve();
      }, 2500),
    ),
  ]);
}

const endpoints = [
  "/api/health",
  "/api/version",
  "/api/meta",
  "/api/setup/first-run",
  "/api/setup/domain",
  "/api/setup/ngrok",
  "/api/setup/browser",
  "/api/anti-spam",
  "/api/accounts",
  "/api/pages",
  "/api/stats",
  "/api/posting/pages",
  "/api/posting/workspace-state",
  "/api/posting/defaults",
  "/api/posting/logs?limit=5",
  "/api/jobs",
  "/api/jobs/rotation/settings",
  "/api/jobs/rotation/matrix",
  "/api/license/status",
  "/api/license/machine",
];

try {
  await waitForHealth();
  const initialSetup = await (
    await fetch(base + "/api/setup/first-run")
  ).json();
  if (initialSetup.ready) {
    throw new Error("Clean runtime unexpectedly started with Meta App configured.");
  }
  const savedSetupResponse = await fetch(base + "/api/setup/first-run", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app1_name: "Clean Runtime App",
      app1_id: "123456789012345",
      app1_secret: "clean-runtime-secret-1234567890",
    }),
  });
  const savedSetup = await savedSetupResponse.json();
  if (!savedSetupResponse.ok || !savedSetup.ready || !savedSetup.env_exists) {
    throw new Error(
      "First-run setup did not create a ready .env: " +
        JSON.stringify(savedSetup),
    );
  }
  for (const endpoint of endpoints) {
    const response = await fetch(base + endpoint);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        endpoint +
          " returned HTTP " +
          response.status +
          ": " +
          text.slice(0, 400),
      );
    }
  }
  const dbFile = path.join(tempRoot, "data", "app.db");
  if (!fs.existsSync(dbFile)) {
    throw new Error("Clean runtime did not create data/app.db.");
  }
  const testDb = new Database(dbFile);
  const account = testDb
    .prepare(
      `INSERT INTO fb_accounts
       (fb_user_id, meta_app_key, meta_app_id, name, user_token_enc)
       VALUES (?, 'app1', ?, ?, ?)`,
    )
    .run("clean-runtime-user", "123456789012345", "Clean Admin", "test-token");
  const page = testDb
    .prepare(
      `INSERT INTO fb_pages
       (account_id, page_id, name, page_token_enc, status)
       VALUES (?, ?, ?, ?, 'active')`,
    )
    .run(account.lastInsertRowid, "clean-runtime-page", "Clean Page", "page-token");
  testDb.close();

  const workspaceResponse = await fetch(base + "/api/posting/workspace-state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      state: {
        selected_page_ids: [Number(page.lastInsertRowid), 999999],
        active_page_id: Number(page.lastInsertRowid),
        active_view: "schedule",
        bulk: { bulkMode: "fixed", bulkCount: "7" },
        rotation: { rotNowPerDay: "3" },
      },
    }),
  });
  const savedWorkspace = await workspaceResponse.json();
  if (
    !workspaceResponse.ok ||
    savedWorkspace.state?.selected_page_ids?.length !== 1 ||
    savedWorkspace.state?.active_view !== "schedule"
  ) {
    throw new Error("Posting workspace did not save valid Page selection: " + JSON.stringify(savedWorkspace));
  }
  const restoredWorkspace = await (
    await fetch(base + "/api/posting/workspace-state")
  ).json();
  if (
    restoredWorkspace.state?.selected_page_ids?.[0] !== Number(page.lastInsertRowid) ||
    restoredWorkspace.state?.bulk?.bulkCount !== "7" ||
    restoredWorkspace.state?.rotation?.rotNowPerDay !== "3"
  ) {
    throw new Error("Posting workspace did not restore last settings: " + JSON.stringify(restoredWorkspace));
  }

  const directPreviewResponse = await fetch(base + "/api/jobs/rotation/run-now", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dry_run: true,
      page_row_ids: [Number(page.lastInsertRowid)],
      posts_per_page_per_day: 2,
      post_type: "text",
      app_rotation_mode: "per_app",
      between_tasks_gap_minutes_min: 12,
      between_tasks_gap_minutes_max: 12,
      same_page_gap_hours_min: 1,
      same_page_gap_hours_max: 1,
      auto_groups_by_meta_app: true,
      groups: [],
      only_enabled_pages: false,
      tz_offset_minutes: 420,
    }),
  });
  const directPreview = await directPreviewResponse.json();
  if (
    !directPreviewResponse.ok ||
    directPreview.summary?.posts_per_page_per_day !== 2 ||
    directPreview.slots?.length !== 2 ||
    directPreview.slots.some((slot) => !slot.iso || "scheduled_publish_time" in slot)
  ) {
    throw new Error("Direct Local preview is not a local-wait/direct plan: " + JSON.stringify(directPreview));
  }

  const invalidWindowResponse = await fetch(base + "/api/jobs/rotation/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "windows",
      page_row_ids: [Number(page.lastInsertRowid)],
      windows: [{ name: "Sai", start: "07:00", end: "10:00", posts: 0 }],
    }),
  });
  if (invalidWindowResponse.status !== 400) {
    throw new Error("Invalid Facebook window count was not rejected.");
  }
  const envFile = path.join(tempRoot, ".env");
  const envText = fs.readFileSync(envFile, "utf8");
  if (
    !envText.includes("FB_APP_ID=123456789012345") ||
    !envText.includes("TOKEN_ENCRYPTION_KEY=")
  ) {
    throw new Error("First-run .env is missing Meta App or encryption settings.");
  }
  console.log(
    "CLEAN RUNTIME PASS: " +
      endpoints.length +
      " endpoints · fresh DB · port " +
      port,
  );
} catch (error) {
  console.error(error.message);
  console.error(output.join("").slice(-6000));
  process.exitCode = 1;
} finally {
  await stopChild();
  const resolvedTemp = path.resolve(tempRoot);
  if (
    resolvedTemp.startsWith(path.resolve(os.tmpdir())) &&
    path.basename(resolvedTemp).startsWith("fbps-clean-runtime-")
  ) {
    fs.rmSync(resolvedTemp, { recursive: true, force: true });
  }
}
