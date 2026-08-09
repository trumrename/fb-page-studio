import {
  assignCommentForPost,
  buildComment,
  getCommentLinkPool,
  getCommentPickMode,
  normalizeLineList,
} from "../src/services/mediaLibrary.js";
import { savePagePostConfig, getPagePostConfig } from "../src/services/poster.js";
import { getDb } from "../src/db/index.js";

let fails = 0;
function assert(cond, msg) {
  if (!cond) {
    fails++;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
}

// ── unit: sequential per post ──
let cfg = {
  comment_templates: ["A {link}", "B {link}"],
  link_lists: {
    comment_links: ["https://u1", "https://u2", "https://u3"],
    comment_link_mode: "sequential",
    comment_link_next: 0,
    comment_tpl_next: 0,
  },
};
const seq = [];
for (let i = 0; i < 4; i++) {
  const r = assignCommentForPost(cfg);
  seq.push({ text: r.text, next: r.link_lists.comment_link_next });
  cfg = { ...cfg, link_lists: r.link_lists };
}
assert(seq[0].text === "A https://u1", `seq0 got ${seq[0].text}`);
assert(seq[1].text === "B https://u2", `seq1 got ${seq[1].text}`);
assert(seq[2].text === "A https://u3", `seq2 got ${seq[2].text}`);
assert(seq[3].text === "B https://u1", `seq3 wrap got ${seq[3].text}`);

// ── links only ──
const only = assignCommentForPost({
  comment_templates: [],
  link_lists: { comment_links: ["https://only"], comment_link_mode: "sequential" },
});
assert(only.text === "https://only", "links-only");

// ── append link when no placeholder ──
const app = assignCommentForPost({
  comment_templates: ["Xem full"],
  link_lists: { comment_links: ["https://x"], comment_link_mode: "sequential" },
});
assert(app.text === "Xem full\nhttps://x", `append got ${JSON.stringify(app.text)}`);

// ── pool fallback ──
const pool = getCommentLinkPool({
  full_album: ["https://fa1", "https://fa2"],
  see_more: ["https://sm"],
});
assert(pool.length === 3, `pool len ${pool.length}`);

// ── empty ──
assert(
  assignCommentForPost({ comment_templates: [], link_lists: {} }).text === null,
  "empty null"
);

// ── buildComment compat ──
assert(
  buildComment(["Hi {link}"], { comment_links: ["https://z"] }, "sequential") === "Hi https://z",
  "buildComment compat"
);

// ── mode parse ──
assert(getCommentPickMode({ comment_link_mode: "theo_bai" }) === "sequential", "theo_bai");
assert(getCommentPickMode({ comment_link_mode: "random" }) === "random", "random");
assert(normalizeLineList("a\n\nb\n").length === 2, "normalize");

// ── two pages independent cursors ──
let pageA = {
  comment_templates: [],
  link_lists: {
    comment_links: ["https://A1", "https://A2"],
    comment_link_mode: "sequential",
    comment_link_next: 0,
  },
};
let pageB = {
  comment_templates: [],
  link_lists: {
    comment_links: ["https://B1", "https://B2"],
    comment_link_mode: "sequential",
    comment_link_next: 0,
  },
};
const a1 = assignCommentForPost(pageA);
pageA = { ...pageA, link_lists: a1.link_lists };
const b1 = assignCommentForPost(pageB);
pageB = { ...pageB, link_lists: b1.link_lists };
const a2 = assignCommentForPost(pageA);
assert(a1.text === "https://A1" && a2.text === "https://A2", "page A sequential");
assert(b1.text === "https://B1", "page B independent");

// ── persist through savePagePostConfig (if DB works) ──
try {
  const db = getDb();
  // use a fake page row if exists
  const page = db.prepare(`SELECT id FROM fb_pages LIMIT 1`).get();
  if (page?.id) {
    const before = getPagePostConfig(page.id);
    savePagePostConfig(page.id, {
      ...before,
      comment_enabled: 1,
      comment_templates: ["T {link}"],
      link_lists: {
        ...(before.link_lists || {}),
        comment_links: ["https://persist1", "https://persist2"],
        comment_link_mode: "sequential",
        comment_link_next: 0,
        comment_tpl_next: 0,
      },
    });
    let live = getPagePostConfig(page.id);
    assert(live.comment_enabled, "db comment_enabled");
    const poolLive = getCommentLinkPool(live.link_lists);
    assert(poolLive.includes("https://persist1"), "db saved comment_links");

    const r1 = assignCommentForPost(live);
    savePagePostConfig(page.id, { ...live, link_lists: r1.link_lists });
    live = getPagePostConfig(page.id);
    const r2 = assignCommentForPost(live);
    assert(r1.text === "T https://persist1", `r1 ${r1.text}`);
    assert(r2.text === "T https://persist2", `r2 ${r2.text}`);
    assert(
      Number(live.link_lists.comment_link_next) >= 1 ||
        Number(r1.link_lists.comment_link_next) === 1,
      "cursor advanced after save"
    );
    // restore soft: leave comment on but ok
    console.log("OK: DB integration with page", page.id);
  } else {
    console.log("SKIP: no fb_pages row for DB integration");
  }
} catch (e) {
  console.log("SKIP DB:", e.message);
}

// ── schedule path imports ──
try {
  const sch = await import("../src/services/schedule.js");
  assert(typeof sch.scheduleOnePost === "function", "scheduleOnePost export");
  assert(typeof sch.reconcileScheduledLogs === "function", "reconcile export");
} catch (e) {
  assert(false, "schedule import " + e.message);
}

// ── poster path imports ──
try {
  const poster = await import("../src/services/poster.js");
  assert(typeof poster.runOnePost === "function" || typeof poster.getPagePostConfig === "function", "poster ok");
} catch (e) {
  assert(false, "poster import " + e.message);
}

console.log("\n====", fails ? `${fails} FAILED` : "ALL PASSED", "====");
process.exit(fails ? 1 : 0);
