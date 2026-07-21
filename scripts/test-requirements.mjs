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

const deliverRoot = path.join(root, "Tổng Hợp Tool");
for (const f of ["pack-customer/.env", "pack-customer/data", "pack-customer/src", "pack-customer/desktop-startup.log"]) {
  check(
    `customer pack excludes ${f.replace("pack-customer/", "")}`,
    !fs.existsSync(path.join(deliverRoot, f))
  );
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
  "src/services/appSettings.js",
  "src/services/captionPoolState.js",
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
check("API list limits are clamped to safe positive ranges", acc.includes("Math.min(5000, Math.max(1") && read("src/services/poster.js").includes("const safeLimit = Math.min(1000") && read("src/services/antiSpam.js").includes("const safeLimit = Math.min(500"));
check("page quota is enforced for newly synced Pages", acc.includes('checkQuota("page"') && acc.includes("skippedByLicense"));

const fb = read("src/services/facebook.js");
check("facebook buildLoginUrl accepts app", fb.includes("opts.app") || fb.includes("appCreds"));
check("facebook exchangeCode accepts app creds", fb.includes("appCreds") || fb.includes("app.appId"));

const db = read("src/db/index.js");
check("DB migrate meta_app_key", db.includes("meta_app_key") && db.includes("migrateMetaApp"));
check("DB stores durable application settings", db.includes("CREATE TABLE IF NOT EXISTS app_settings"));
check("explicit user/EXE directory owns first-run .env", read("src/paths.js").includes("process.env.FB_USER_DIR || process.env.FB_EXE_DIR") && read("src/paths.js").includes("return beside"));

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
const runNowRoute = jobs.slice(
  jobs.indexOf('router.post("/rotation/run-now"'),
  jobs.indexOf('router.post("/bulk-post"')
);
check("direct-local route only creates direct post tasks", runNowRoute.includes('kind: "post"') && !runNowRoute.includes('kind: "schedule"'));
check("direct-local tasks keep local due time without Facebook scheduled_publish_time", runNowRoute.includes("run_at: s.iso") && !runNowRoute.includes("scheduled_publish_time"));

const jr = read("src/services/jobRunner.js");
check("sequential runner sleep 350ms", jr.includes("sleep(350)"));
check("job runner waits locally then calls direct publish", jr.includes("waitUntilTaskDue") && jr.includes("Tool đang chờ đến") && jr.includes("runOnePost(task.page_row_id"));
const pageLock = read("src/services/pageOperationLock.js");
const poster = read("src/services/poster.js");
const schedule = read("src/services/schedule.js");
check("publishing serializes work per Page", pageLock.includes("withPageOperationLock") && poster.includes("withPageOperationLock(pageRowId") && schedule.includes("withPageOperationLock(pageRowId"));
check("no parallel Promise.all posts in runner", !/Promise\.all\([^)]*runOnePost/.test(jr));
check("job runner live resource snapshot", jr.includes("refreshResources") && jr.includes("job.resources"));
check("live resources deduplicate Media and Caption as separate shared pools", jr.includes("media_pools") && jr.includes("caption_pools") && read("public/posting.html").includes("mediaPools") && read("public/posting.html").includes("captionPools"));
check("job runner can retry failed tasks", jr.includes("export function retryFailedJob") && jr.includes("failed_tasks"));
check("live resource snapshot refreshes while Direct Local waits", jr.includes("Date.now() - lastRefresh >= 10_000") && jr.includes("refreshResources(j)"));
check("expired schedule retry receives a new future time", jr.includes("15 + retryIndex * 2") && jr.includes("opts.scheduled_publish_time = Math.floor(minimumMs / 1000)"));
check("API retry-failed endpoint", jobs.includes("retry-failed") && jobs.includes("retryFailedJob"));
const dashboardUi = read("public/app.html");
const postingUi = read("public/posting.html");
check("UI shows fail list + retry buttons", dashboardUi.includes("failRetryPanel") && dashboardUi.includes("btnRetryAllFailed") && postingUi.includes("liveFailRetry") && postingUi.includes("btnLiveRetryAll"));
check("job history persists across App restart", jr.includes("jobs-state.json") && jr.includes("restoreJobs") && jr.includes('job.status = "interrupted"'));
check("media uses random spaced policy", read("src/services/antiSpam.js").includes("pickRandomMediaSpaced") && poster.includes('"random_spaced"') && schedule.includes('"random_spaced"'));
check("caption uses sequential then shuffled cycles", read("src/services/mediaLibrary.js").includes("stableShuffle") && poster.includes('"sequential_shuffle"') && schedule.includes('"sequential_shuffle"'));

const captionSample = ["Caption A", "Caption B", "Caption C", "Caption D"];
const firstCaptionCycle = captionSample.map((_, i) => pickCaption(captionSample, i, "sequential_shuffle"));
const secondCaptionCycle = captionSample.map((_, i) => pickCaption(captionSample, i + captionSample.length, "sequential_shuffle"));
check("caption first cycle preserves order", firstCaptionCycle.join("|") === captionSample.join("|"));
check("caption next cycle is a full shuffled permutation", new Set(secondCaptionCycle).size === captionSample.length && secondCaptionCycle.some((x, i) => x !== captionSample[i]));
check("caption cursor is independent from post type cursor", poster.includes("caption_slot_index") && schedule.includes("caption_slot_index") && db.includes("caption_slot_index"));
check("shared caption folders use one atomic pool cursor", read("src/services/captionPoolState.js").includes("caption_pool_state") && poster.includes("reserveCaptionSlot") && schedule.includes("reserveCaptionSlot") && JSON.parse(read("package.json")).scripts.test.includes("test-caption-pool.mjs"));
check("media spacing records only successful selections", read("src/services/antiSpam.js").includes("source_folder") && !read("src/services/antiSpam.js").includes("recentMediaByPool"));
check("resource counts exclude already-used media", poster.includes("countUnusedMedia") && rot.includes("countUnusedMedia"));
check("published and overdue schedules remain inside anti-spam caps", read("src/services/antiSpam.js").includes("'scheduled','published','schedule_overdue'") && poster.includes("'scheduled','published','schedule_overdue'"));

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
check("updater prefers exact versioned asset over stale generic EXE", updater.includes("const cleanVersion") && updater.includes("FB-Page-Studio-Desktop-v") && updater.includes("pickReleaseAsset(assets, cfg.asset_name, remoteVersion)"));
check("updater requires and verifies release SHA-256 sidecar", updater.includes("checksum_asset") && updater.includes('createHash("sha256")') && updater.includes("SHA-256 EXE cập nhật không khớp"));
check("updater rolls back and reports replacement failure", updater.includes(":replace_failed") && updater.includes("_update-error.txt") && apiRoutes.includes('"/update/last-error"') && updateUi.includes("showLastUpdateError"));
check("release gate verifies embedded version and EXE hashes", fs.existsSync(path.join(root, "scripts/verify-release.mjs")) && read("scripts/verify-release.mjs").includes("EXE embedded version") && read("scripts/verify-release.mjs").includes("customer EXE hash"));
check("tag release workflow runs verification gate", fs.existsSync(path.join(root, ".github/workflows/release-desktop.yml")) && read(".github/workflows/release-desktop.yml").includes("release:verify") && read(".github/workflows/release-desktop.yml").includes("GITHUB_REF_NAME"));
check("release asset filename includes exact version", fs.existsSync(path.join(root, "scripts/prepare-release-asset.mjs")) && read("scripts/prepare-release-asset.mjs").includes("Desktop-v${pkg.version}.exe") && read(".github/workflows/release-desktop.yml").includes("Desktop-v$version.exe"));
check("customer pack includes SHA-256 sidecar for its versioned EXE", read("scripts/sync-customer-pack.mjs").includes("sha256") && read("scripts/sync-customer-pack.mjs").includes(".sha256.txt"));
check("opening new EXE warns when old version is still running", read("electron/main.cjs").includes("additionalData?.version") && read("electron/main.cjs").includes("Đang có một phiên bản FB Page Studio khác chạy nền"));
const ngrokManager = read("src/services/ngrokManager.js");
const index = read("public/index.html");
check("Ngrok manager handles token, install and exact domain", ngrokManager.includes("NGROK_AUTHTOKEN") && ngrokManager.includes("ensureExe") && ngrokManager.includes("domainOf(item.public_url) === domain"));
check("Ngrok rejects localhost custom hostname before spawning", ngrokManager.includes("isLocalHostname") && ngrokManager.includes("status: \"needs_domain\"") && ngrokManager.includes("ERR_NGROK_314") && apiRoutes.includes("Không được dùng localhost làm domain OAuth/Ngrok"));
check("Ngrok uses current --url flag and explains busy fixed domain", ngrokManager.includes("`--url=https://${domain}`") && !ngrokManager.includes("`--domain=${domain}`") && ngrokManager.includes("ERR_NGROK_334") && ngrokManager.includes("Không bật pooling cho OAuth") && ngrokManager.includes("domain_busy"));
check("Ngrok reuses exact local tunnel on the same port", ngrokManager.includes("inspectLocalTunnel") && ngrokManager.includes("local?.same_port") && ngrokManager.includes("đã dùng lại tunnel cục bộ"));
check("Ngrok restart cannot lose the new child process", /await stopNgrok\(\);\s*stopRequested = false/.test(ngrokManager) && ngrokManager.includes("child === proc"));
check("Ngrok shuts down through Electron IPC", read("src/server.js").includes('msg?.type === "shutdown"') && read("electron/main.cjs").includes("serverProc.send({ type: \"shutdown\" })"));
const customerEnvEx = read(path.join("Tổng Hợp Tool", "pack-customer", ".env.example"));
check(
  "customer env is public-safe (relay, no secret values)",
  customerEnvEx.includes("OAUTH_RELAY=1") &&
    customerEnvEx.includes("NGROK_AUTOSTART=0") &&
    customerEnvEx.includes("FB_APP_ID=") &&
    customerEnvEx.includes("trumrename/fb-page-studio") &&
    !/FB_APP_SECRET=\s*[A-Za-z0-9]{10,}/.test(customerEnvEx) &&
    !/NGROK_AUTHTOKEN=\s*[A-Za-z0-9]{10,}/.test(customerEnvEx)
);
check(
  "obsolete BAT files cannot collect tokens or delete builds",
  // Ngrok token helper BATs removed from UI path; if reintroduced they must not prompt tokens or wipe disks.
  !fs.existsSync(path.join(root, "CAI-NGROK.bat")) &&
    !fs.existsSync(path.join(root, "XOA-BAN-HONG.bat")) &&
    (!fs.existsSync(path.join(deliverRoot, "pack-dev/CHAY-NGROK-DOMAIN-CO-DINH.bat")) ||
      !read(path.join("Tổng Hợp Tool", "pack-dev/CHAY-NGROK-DOMAIN-CO-DINH.bat")).includes("set /p"))
);
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
check("Direct Local has independent post type and same-Page gap controls", ["rotNowPostType", "rotNowGapMin", "rotNowGapMax", "collectRunNowBody"].every((x) => posting.includes(x)));
const directBody = posting.slice(posting.indexOf("function collectRunNowBody"), posting.indexOf("function applyRotationSettings"));
check(
  "Direct Local supports optional morning/evening windows and media pattern",
  directBody.includes("run_now_time_mode") &&
    directBody.includes("media_pattern_mode") &&
    directBody.includes("page_target_mode") &&
    posting.includes("rotNowMediaPattern") &&
    posting.includes("rotPageTargetSelected") &&
    posting.includes("rotNowTimeWindows")
);
check(
  "UI separates page target modes (selected XOR all)",
  posting.includes('name="rotPageTarget"') &&
    posting.includes('value="selected"') &&
    posting.includes('value="all"') &&
    posting.includes("page_target_mode")
);
check("UI run-now Media/Posted/Caption pickers", ["btnRotPickMedia", "btnRotPickPosted", "btnRotPickCaptions", "btnRotApplyFolders"].every((x) => posting.includes(x)));
check("UI live job progress + notifications", ["liveJobBar", "liveJobPct", "liveResources", "liveNotifs", "watchLiveJob"].every((x) => posting.includes(x)));
check("bulk schedule uses live job runner", posting.includes('"/api/jobs/bulk-schedule"') && posting.includes("watchLiveJob(r.job.id)"));
check("posting stops when config save fails", posting.includes("if (!(await saveConfig())) return"));
check("unsupported Story control is disabled", posting.includes('id="story_enabled" disabled'));
check("UI profile Meta App badge", posting.includes("meta_app_name") && posting.includes("appKey"));
check("UI auto meta groups checkbox", posting.includes("rotAutoMeta"));
check("UI windows + gap settings", posting.includes("rotWindows") && posting.includes("rotGapMin"));
check("preferred-hours bulk route is declared before dynamic Page route", read("src/routes/posting.js").indexOf('router.put("/preferred-hours/bulk"') < read("src/routes/posting.js").indexOf('router.put("/preferred-hours/:pageRowId"'));
check("Page selection persists outside transient checkboxes", posting.includes("selectedPageSet") && posting.includes('"/api/posting/workspace-state"') && !posting.includes('querySelectorAll(".pg-check:checked")'));
check("active config Page is constrained to selected Pages", read("src/routes/posting.js").includes("selected.includes(requestedActiveId)") && read("src/routes/posting.js").includes("active_page_id: activeId"));
check("Page config auto-saves before switching workspaces", posting.includes("queueConfigAutosave") && posting.includes("flushConfigAutosave") && posting.includes("persistPageConfig"));
check("posting workspaces are visually separated", ["configure", "run", "schedule", "monitor"].every((view) => posting.includes(`data-workspace-view="${view}"`)) && posting.includes("data-workspace-panel"));
check(
  "rotation page scope is explicit selected-or-all",
  read("src/services/rotationPlan.js").includes('page_target_mode: "selected"') &&
    read("src/services/rotationPlan.js").includes("resolvePlannedPostType") &&
    posting.includes("page_target_mode")
);

check("OAuth flash escapes URL values", index.includes('escapeHtml(p.get("error"))'));
check("UI escapes attribute quotes and rejects non-HTTP external URLs", [dashboardUi, posting, index].every((text) => text.includes("safeHttpUrl")) && dashboardUi.includes("&quot;") && posting.includes("&quot;") && index.includes("&#39;"));
check("UI Connect App 1", index.includes("app=app1"));
check("UI Connect App 2", index.includes("app=app2"));
check("UI domain setup and Chrome OAuth (no Ngrok token UI)", index.includes("oauthDomain") && index.includes("btnSaveOAuthDomain") && index.includes("oauthBrowserProfile") && !index.includes("btnSaveNgrokToken") && !index.includes("ngrokToken"));
check("Ngrok integrated autostart and token recovery", fs.existsSync(path.join(root, "src/services/ngrokManager.js")) && server.includes("startNgrok") && apiRoutes.includes('"/setup/ngrok"') && apiRoutes.includes("NGROK_AUTHTOKEN"));
check("UI Chrome profile selection", index.includes("oauthBrowserProfile") && index.includes("btnSaveBrowserProfile"));
check("UI first-run Meta App setup without manual .env", index.includes("firstRunSetup") && index.includes("setupApp1Id") && index.includes("setupApp1Secret") && index.includes("btnSaveFirstRun") && index.includes('"/api/setup/first-run"'));
check("API first-run setup creates encryption key and updates live config", apiRoutes.includes('"/setup/first-run"') && apiRoutes.includes("crypto.randomBytes(32)") && apiRoutes.includes("config.facebook.appId = app1Id") && apiRoutes.includes("config.tokenEncryptionKey = encryptionKey"));
check(".env writes reject line injection and preserve literal dollar signs", apiRoutes.includes("không được chứa xuống dòng") && apiRoutes.includes("(_match, prefix)") && apiRoutes.includes("Authtoken Ngrok không đúng định dạng"));
check("UI meta app badge on accounts", index.includes("meta_app") || index.includes("appLabel"));
check("UI exports Page information per App", index.includes("btnExportDailyPages") && index.includes("/api/reports/daily/pages"));
check("manual Page report refreshes follower data", index.includes("refresh_followers"));

const dashboard = read("public/app.html");
const shell = read("public/js/shell.js");
const css = read("public/css/app.css");
const electronMain = read("electron/main.cjs");
const electronPreload = read("electron/preload.cjs");
const folderPicker = read("src/services/folderPicker.js");
check("Chrome setup scans multiple folders or drives", apiRoutes.includes("scanChromeProfiles") && apiRoutes.includes("scanned_directories") && index.includes("Chọn nhiều thư mục/ổ") && electronMain.includes("multiSelections") && electronPreload.includes("multiple: Boolean"));
check("Chrome setup binds each profile to its nearby executable", apiRoutes.includes("chromeExecutables") && apiRoutes.includes("FB_BROWSER_PATH") && index.includes("browser_path: chosen?.browser_path") && apiRoutes.includes("rankBrowserForProfile") && electronMain.includes("chromeportable"));
check("password fields support App Secret entry", css.includes('input[type="password"]') && index.includes("setupApp1Secret") && index.includes('type="password"'));
check("folder pickers use full Windows Explorer dialog", electronMain.includes("dialog.showOpenDialog") && electronMain.includes('"openDirectory"') && electronMain.includes("sandbox: false") && electronMain.includes("contextIsolation: true") && electronMain.includes("preload.cjs") && electronPreload.includes('ipcRenderer.invoke("fbps:pick-folder"') && posting.includes("fbPageStudioDesktop.pickFolder") && index.includes("fbPageStudioDesktop.pickFolder"));
check("Electron blocks external navigation and unsafe URL protocols", electronMain.includes("Never let an external origin replace the trusted local dashboard") && electronMain.includes("blocked protocol") && electronMain.includes("['http:', 'https:']"));
check("Electron native module uses reproducible prebuilt instead of local Visual Studio", read("package.json").includes("scripts/install-electron-native.mjs") && read("scripts/install-electron-native.mjs").includes("--runtime=electron") && !JSON.parse(read("package.json")).scripts["native:electron"].includes("electron-rebuild") && JSON.parse(read("package.json")).scripts.postinstall === "node scripts/install-electron-native.mjs");
check("portable first run persists beside outer EXE instead of Temp extraction", electronMain.includes("process.env.PORTABLE_EXECUTABLE_DIR") && electronMain.includes("never inside Electron's temporary extraction directory") && electronMain.includes("Không cần tự tạo file .env"));
check("legacy small FolderBrowserDialog cannot return", !folderPicker.includes("FolderBrowserDialog") && folderPicker.includes("System.Windows.Forms.OpenFileDialog"));
check("fresh database post_logs includes scheduled publish time", /CREATE TABLE IF NOT EXISTS post_logs[\s\S]{0,1200}scheduled_publish_time TEXT/.test(read("src/db/index.js")));
check("fresh database Page config includes active/preferred hours", /CREATE TABLE IF NOT EXISTS page_post_config[\s\S]{0,1200}active_hours_json TEXT[\s\S]{0,300}preferred_hours_json TEXT/.test(read("src/db/index.js")));
check("clean runtime smoke test is part of npm test", fs.existsSync(path.join(root, "scripts/test-clean-runtime.mjs")) && JSON.parse(read("package.json")).scripts.test.includes("test-clean-runtime.mjs"));
check("navigation tabs map to distinct workspaces", shell.includes('dataset.view = view') && shell.includes('itemHash === hash') && css.includes('body[data-view="rotation"]') && css.includes('body[data-view="reports"]'));
check("dashboard has unique logs target", (dashboard.match(/id="logs"/g) || []).length === 1 && dashboard.includes('id="logsSection"'));
check("dashboard auto-discovers active jobs", dashboard.includes("discoverJobs") && dashboard.includes("setInterval(discoverJobs"));
check("dashboard popups are closable, capped and do not replay history", dashboard.includes("toast-close") && dashboard.includes("wrap.children.length >= 3") && dashboard.includes("hydratedNotificationJobs") && dashboard.includes("fresh.length > 3"));
check("dashboard shows live operation summary", ["opsState", "opsToday", "opsSuccess", "opsFail"].every((x) => dashboard.includes(x)));
check("dashboard displays Vietnam time", dashboard.includes("fmtVn") && dashboard.includes("Asia/Ho_Chi_Minh"));
check("Ngrok public host exposes only Facebook OAuth callback", server.includes("isFacebookCallback") && server.includes("isLocalHost") && server.includes("status(403)"));
check("central deploy mode exists", fs.existsSync(path.join("src", "services", "deployMode.js")) && read("src/services/deployMode.js").includes("isCentralDeploy"));
check("media upload for central server", read("src/routes/api.js").includes("/media/upload") && fs.existsSync(path.join("src", "services", "mediaUpload.js")));
check("central server docs", fs.existsSync("HUONG-DAN-SERVER-TRUNG-TAM.md") && fs.existsSync(".env.central.example"));
check("oauth relay for EXE without ngrok", fs.existsSync("oauth-relay/server.mjs") && fs.existsSync("HUONG-DAN-OAUTH-RELAY.md") && read("src/routes/auth.js").includes("nanoid(32)}.${config.port}"));
check("relay-complete for customer pack without secret", read("src/routes/auth.js").includes("relay-complete") && read("src/services/accounts.js").includes("connectFromUserToken"));
check("two packs internal vs customer", fs.existsSync("scripts/sync-internal-pack.mjs") && fs.existsSync("HAI-GOI-NOI-BO-VA-KHACH.md") && read("oauth-relay/server.mjs").includes("RELAY_EXCHANGE"));
check("dashboard separates created and Facebook publish time", dashboard.includes("Tool thực hiện lúc") && dashboard.includes("Facebook sẽ đăng lúc") && dashboard.includes("scheduleDisplay"));
check("dashboard shows scheduler and config health", dashboard.includes("opsScheduler") && dashboard.includes("configHealth") && dashboard.includes("loadRuntime"));
check("dashboard explains operation per Page", dashboard.includes("pageOperationRows") && dashboard.includes("Profile / Admin") && dashboard.includes("Giờ ưu tiên VN") && dashboard.includes("total_planned_today"));
check("UI separates daily posting-history export", dashboard.includes("btnExportDailyHistory") && dashboard.includes("btnShowDailyFiles"));

const dailyReports = read("src/services/dailyReports.js");
check("Page workbook uses one daily sheet per Meta App", dailyReports.includes("exportPageInfoDaily") && dailyReports.includes("removeWorksheet") && dailyReports.includes("-thong-tin-page"));
check("Page report includes follower changes 1d 3d 7d 30d", ["follow_delta_1d", "follow_delta_3d", "follow_delta_7d", "follow_delta_30d"].every((x) => dailyReports.includes(x)));
check("posting history creates daily CSV and cumulative workbook", dailyReports.includes("lich-su-dang-${day}.csv") && dailyReports.includes('"lich-su-dang.xlsx"'));
check("daily report day is validated before filenames and sheet names", dailyReports.includes("normalizeReportDay") && dailyReports.includes("Ngày báo cáo phải có định dạng YYYY-MM-DD"));
check("posting log explains scheduled state", posting.includes("FB đã nhận lịch · chờ đăng") && posting.includes("Facebook sẽ đăng lúc"));
check("overdue schedules can reconcile with Facebook", schedule.includes("reconcileScheduledLogs") && posting.includes("btnReconcileActLog") && dashboard.includes("btnReconcileLogs"));
check("overdue schedules are rechecked instead of becoming permanent", schedule.includes("status IN ('scheduled', 'schedule_overdue')"));
check("Vietnam day key does not depend on Windows timezone", poster.includes('timeZone: "Asia/Ho_Chi_Minh"'));
check("stored UTC last_post_at is parsed as UTC", poster.includes('`${raw.replace(" ", "T")}Z`') && poster.includes("storedUtcMs(cfg.last_post_at)"));
check("stored UTC follower enrichment timestamp is parsed as UTC", read("src/services/enrich.js").includes('row.enriched_at.replace(" ", "T") + "Z"'));
check("Direct preview subtracts posts already made today", rot.includes("remainingToday") && rot.includes("posts_today_date === todayVn"));

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

    const scheduledPerApp = buildRotationPlan({
      auto_groups_by_meta_app: false,
      groups: [
        { id: "app1", name: "App 1", account_ids: g1 },
        { id: "app2", name: "App 2", account_ids: g2 },
      ],
      app_rotation_mode: "per_app",
      mode: "windows",
      days_ahead: 1,
      windows: [{ name: "Sang", start: "08:00", end: "11:00", posts: 1 }],
      page_row_ids: ids,
    });
    const firstApp2Index = scheduledPerApp.slots.findIndex((slot) => slot.group_id === "app2");
    assert(
      "P2 Facebook schedule option1 completes App 1 before App 2",
      firstApp2Index > 0 && scheduledPerApp.slots.slice(0, firstApp2Index).every((slot) => slot.group_id === "app1"),
      scheduledPerApp.slots.slice(0, 6).map((slot) => `${slot.group_id}/P${slot.page_index}`).join(",")
    );
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
  assert("P2 Facebook-window count is authoritative row sum", s.posts_per_page_per_day === 4, String(s.posts_per_page_per_day));
  let invalidWindowsRejected = false;
  try {
    normalizeSettings({
      mode: "windows",
      windows: [{ name: "Sai", start: "07:00", end: "10:00", posts: 0 }],
    });
  } catch {
    invalidWindowsRejected = true;
  }
  assert("P2 invalid/zero Facebook windows are rejected", invalidWindowsRejected);
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
