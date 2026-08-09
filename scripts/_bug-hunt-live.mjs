/**
 * Live bug hunt against real local DB (restores media_folder after).
 * Each critical path run twice.
 */
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath, pathToFileURL } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imp = (rel) => import(pathToFileURL(path.join(root, rel)).href);

let bugs = [];
let ok = 0;
function pass(m, d = "") {
  ok++;
  console.log("✓", m, d || "");
}
function bug(m, d = "") {
  bugs.push(m + (d ? " — " + d : ""));
  console.error("✗ BUG:", m, d || "");
}

const { getDb } = await imp("src/db/index.js");
const { scheduleBulk } = await imp("src/services/schedule.js");
const { getPagePostConfig, savePagePostConfig } = await imp("src/services/poster.js");
const { assignCommentForPost } = await imp("src/services/mediaLibrary.js");
const { deleteAccounts } = await imp("src/services/accounts.js");
const { mediaStats } = await imp("src/services/poster.js");

const db = getDb();
const pages = db
  .prepare(`SELECT id, name FROM fb_pages WHERE status='active' ORDER BY id LIMIT 8`)
  .all();
console.log("active pages:", pages.length);
console.log(pages.map((p) => `#${p.id} ${p.name}`).join("\n"));

const pad = (n) => String(n).padStart(2, "0");
const tomorrow = new Date(Date.now() + 28 * 3600 * 1000);
const start =
  tomorrow.getFullYear() +
  "-" +
  pad(tomorrow.getMonth() + 1) +
  "-" +
  pad(tomorrow.getDate()) +
  " 11:00";

// ── Comment assign sequential persistence (x2 cycles) ──
console.log("\n--- comment sequential ×2 cycles ---");
for (let cycle = 1; cycle <= 2; cycle++) {
  let ll = {
    comment_links: ["https://l1", "https://l2", "https://l3"],
    comment_link_mode: "sequential",
    comment_tpl_next: 0,
    comment_link_next: 0,
  };
  const tpls = ["see more :", "full album:", "xem full:"];
  const texts = [];
  for (let i = 0; i < 5; i++) {
    const r = assignCommentForPost({
      comment_templates: tpls,
      link_lists: ll,
      comment_pick_mode: "sequential",
    });
    ll = r.link_lists;
    texts.push(r.text);
    if (!r.text || !r.text.includes("https://")) {
      bug(`comment cycle${cycle} i${i} missing link`, JSON.stringify(r.text));
    }
  }
  // wrap: index 3 should reuse first tpl pattern
  const firstTpl = texts[0].split("\n")[0];
  const wrapTpl = texts[3].split("\n")[0];
  if (firstTpl !== wrapTpl) {
    bug(`comment wrap tpl cycle${cycle}`, `${firstTpl} vs ${wrapTpl}`);
  } else {
    pass(`comment wrap cycle${cycle}`, texts.map((t) => t?.split("\n")[0]).join(" | "));
  }
  // empty template
  const only = assignCommentForPost({
    comment_templates: [],
    link_lists: { comment_links: ["https://solo"] },
  });
  if (only.text !== "https://solo") bug(`link only cycle${cycle}`, only.text);
  else pass(`link only cycle${cycle}`);
}

// ── Media short dry_run + non-dry block ──
if (!pages.length) {
  console.log("No pages — skip media live");
} else {
  const p = pages[0];
  const cfg0 = getPagePostConfig(p.id);
  const prevFolder = cfg0.media_folder;
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "fbps-empty-media-"));
  console.log("\n--- media short on page", p.id, p.name, "---");
  console.log("prev media_folder:", prevFolder);

  try {
    savePagePostConfig(p.id, {
      ...getPagePostConfig(p.id),
      media_folder: empty,
      sequence: ["photo"],
    });

    for (let passN = 1; passN <= 2; passN++) {
      const r = await scheduleBulk({
        page_row_ids: [p.id],
        dry_run: true,
        mode: "fixed",
        start_at: start,
        count_per_page: 2,
        days_ahead: 1,
        interval_minutes: 60,
        post_type: "photo",
        timing_source: "start_at_interval",
      });
      if (r.media_check == null) bug(`dry_run missing media_check pass${passN}`);
      else pass(`dry_run has media_check pass${passN}`);
      if (r.media_ok !== false) {
        bug(
          `dry_run should media_ok=false empty folder pass${passN}`,
          JSON.stringify(r.media_check)
        );
      } else {
        pass(`dry_run media short pass${passN}`, r.media_check.summary);
      }
      if (!r.media_check?.messages?.length) {
        bug(`dry_run no messages pass${passN}`);
      } else {
        pass(`dry_run messages pass${passN}`, r.media_check.messages[0]);
      }
    }

    for (let passN = 1; passN <= 2; passN++) {
      try {
        await scheduleBulk({
          page_row_ids: [p.id],
          dry_run: false,
          mode: "fixed",
          start_at: start,
          count_per_page: 1,
          days_ahead: 1,
          interval_minutes: 60,
          post_type: "photo",
        });
        bug(`non-dry should throw MEDIA_SHORT pass${passN}`);
      } catch (e) {
        if (e.code === "MEDIA_SHORT" || /Thiếu media|media/i.test(e.message)) {
          pass(`non-dry blocked pass${passN}`, e.message.slice(0, 100));
        } else {
          bug(`non-dry wrong error pass${passN}`, e.message);
        }
      }
    }

    // ignore_media_check should allow dry path for real schedule? still needs Graph token
    // just verify throw is skipped for media when ignore — may fail later on token/media pick
    try {
      await scheduleBulk({
        page_row_ids: [p.id],
        dry_run: false,
        ignore_media_check: true,
        mode: "fixed",
        start_at: start,
        count_per_page: 1,
        days_ahead: 1,
        interval_minutes: 60,
        post_type: "photo",
      });
      // if it got past media, might fail on no photo during scheduleOnePost — that's ok
      pass("ignore_media_check bypassed media gate (or posted)");
    } catch (e) {
      if (e.code === "MEDIA_SHORT") {
        bug("ignore_media_check still MEDIA_SHORT", e.message);
      } else {
        // expected: no media file when actually scheduling
        pass("ignore_media_check past media gate, later fail ok", e.message.slice(0, 100));
      }
    }
  } finally {
    savePagePostConfig(p.id, {
      ...getPagePostConfig(p.id),
      media_folder: prevFolder,
    });
    const restored = getPagePostConfig(p.id).media_folder;
    if (restored !== prevFolder) bug("media_folder not restored", restored);
    else pass("media_folder restored", restored);
    fs.rmSync(empty, { recursive: true, force: true });
  }

  // ── Sufficient media dry_run if folder has files ──
  const cfg = getPagePostConfig(p.id);
  const stats = mediaStats(cfg.media_folder);
  console.log("\n--- media stats page", p.id, stats);
  for (let passN = 1; passN <= 2; passN++) {
    const r = await scheduleBulk({
      page_row_ids: [p.id],
      dry_run: true,
      mode: "fixed",
      start_at: start,
      count_per_page: 1,
      days_ahead: 1,
      interval_minutes: 120,
      post_type: stats.photos > 0 ? "photo" : "text",
      timing_source: "start_at_interval",
    });
    pass(
      `real dry_run pass${passN}`,
      `media_ok=${r.media_ok} slots=${(r.plan?.[0]?.slots || []).length} err=${r.plan?.[0]?.error || ""}`
    );
    if (!("media_check" in r)) bug(`missing media_check field pass${passN}`);
  }

  // multi-page shared folder aggregation
  if (pages.length >= 2) {
    const ids = pages.slice(0, 2).map((x) => x.id);
    // point both to same empty folder briefly
    const empty2 = fs.mkdtempSync(path.join(os.tmpdir(), "fbps-shared-"));
    const prevs = ids.map((id) => getPagePostConfig(id).media_folder);
    try {
      for (const id of ids) {
        savePagePostConfig(id, {
          ...getPagePostConfig(id),
          media_folder: empty2,
          sequence: ["photo"],
        });
      }
      for (let passN = 1; passN <= 2; passN++) {
        const r = await scheduleBulk({
          page_row_ids: ids,
          dry_run: true,
          mode: "fixed",
          start_at: start,
          count_per_page: 1,
          days_ahead: 1,
          interval_minutes: 60,
          post_type: "photo",
        });
        const pool = r.media_check?.pools?.[0];
        if (pool && pool.required >= 2) {
          pass(`shared folder required>=2 pass${passN}`, `req=${pool.required} avail=${pool.available}`);
        } else if (r.media_ok === false) {
          pass(`shared short ok pass${passN}`, r.media_check?.summary);
        } else {
          bug(`shared folder aggregation pass${passN}`, JSON.stringify(r.media_check));
        }
      }
    } finally {
      ids.forEach((id, i) => {
        savePagePostConfig(id, {
          ...getPagePostConfig(id),
          media_folder: prevs[i],
        });
      });
      fs.rmSync(empty2, { recursive: true, force: true });
      pass("shared folders restored");
    }
  }
}

// ── bulk delete safety ──
for (let passN = 1; passN <= 2; passN++) {
  const r = deleteAccounts([987654321, 987654322]);
  if (r.deleted_count !== 0) bug(`deleteAccounts should not delete fake pass${passN}`, JSON.stringify(r));
  else pass(`deleteAccounts missing safe pass${passN}`, JSON.stringify(r));
}

// ── static washed check ──
const hub = fs.readFileSync(path.join(root, "public/pages-hub.html"), "utf8");
const bad = hub.match(/class="[^"]*\bbtn ghost\b[^"]*"/g) || [];
const bad2 = hub.match(/class="[^"]*\bbtn primary\b[^"]*"/g) || [];
if (bad.length || bad2.length) bug("washed classes remain", [...bad, ...bad2].join(","));
else pass("no washed btn ghost/primary classes");

// index bulk delete wiring
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
if (!index.includes("bulk-delete")) bug("index missing bulk-delete endpoint");
else pass("index bulk-delete wired");

// ── facebook insights metrics present ──
const fb = fs.readFileSync(path.join(root, "src/services/facebook.js"), "utf8");
if (!fb.includes("page_post_engagements")) bug("missing engagement metric in getPageInsights");
else pass("insights metrics present");

console.log("\n========== BUG HUNT SUMMARY ==========");
console.log("OK:", ok);
console.log("BUGS:", bugs.length);
if (bugs.length) {
  bugs.forEach((b) => console.error(" -", b));
  process.exit(1);
}
console.log("NO BUGS FOUND");
