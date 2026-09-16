/**
 * Test: comment prefix (câu đầu) + link khớp media; smoke login/auth endpoints.
 */
import assert from "assert";
import {
  assignCommentForPost,
  pickLinkByMediaOrdinal,
  pickCommentTemplateByMediaOrdinal,
  parseNumberedCommentTemplate,
  extractLongIdsFromMediaName,
} from "../src/services/mediaLibrary.js";

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log("PASS", name);
  else {
    failed += 1;
    console.log("FAIL", name, detail);
  }
}

const reelId = "1376182584691551";
const reelUrl = `https://www.facebook.com/reel/${reelId}/`;

// --- 1) FB id in filename ---
check(
  "extractLongIdsFromMediaName",
  extractLongIdsFromMediaName(`3-${reelId}.mp4`).includes(reelId)
);
check(
  "pickLink by facebook id",
  pickLinkByMediaOrdinal(
    ["https://www.facebook.com/reel/999/", reelUrl, "https://dailyscope.x/aaa"],
    `3-${reelId}.mp4`
  ).url === reelUrl
);

// --- 2) Numbered link line ---
check(
  "pickLink by line ordinal 9",
  pickLinkByMediaOrdinal(
    [
      "1. https://dailyscope.x/a",
      `9. ${reelUrl}`,
      "2. https://dailyscope.x/b",
    ],
    "9-video-title.mp4"
  ).reason === "line_ordinal"
);

// --- 3) Câu kèm + số + strip prefix ---
const parsed = parseNumberedCommentTemplate(
  `9. Critics who doubted the strategy fell into sudden silence. ${reelUrl}`
);
check("parse ordinal 9", parsed.ordinal === 9);
check(
  "parse strips number from text",
  parsed.text === "Critics who doubted the strategy fell into sudden silence."
);
check("parse embedded url", parsed.url === reelUrl.replace(/\/$/, "") || parsed.url.includes(reelId));

const tpl = pickCommentTemplateByMediaOrdinal(
  [
    "1. First opener",
    "9. Critics who doubted the strategy fell into sudden silence.",
    "2. Second opener",
  ],
  "9-eric.mp4"
);
check("template match ordinal", tpl.matched && tpl.text.startsWith("Critics"));

// --- 4) Full assign: media 9 → câu 9 + link 9 ---
const full = assignCommentForPost({
  page_row_id: 1,
  pick_mode: "match_media",
  post_round: 9,
  comment_templates: [
    "1. Opener one",
    "9. Critics who doubted the strategy fell into sudden silence.",
    "2. Opener two",
  ],
  link_lists: {
    comment_links: [
      "1. https://dailyscope.x/one",
      `9. ${reelUrl}`,
      "2. https://dailyscope.x/two",
    ],
    comment_link_mode: "random", // must still match because pick_mode=match_media
  },
  media_path: `C:/v/9-${reelId}.mp4`,
});
check("assign link is reel 9", String(full.link || "").includes(reelId), full.link);
check(
  "assign text has Critics prefix (no leading 9.)",
  String(full.text || "").startsWith("Critics who doubted"),
  full.text
);
check(
  "assign text includes reel url",
  String(full.text || "").includes(reelId),
  full.text
);
check(
  "assign does NOT start with '9.'",
  !String(full.text || "").trim().startsWith("9."),
  full.text
);

// --- 5) Shared media post_round index (bare URLs) ---
const bare = assignCommentForPost({
  page_row_id: 2,
  pick_mode: "match_media",
  post_round: 3,
  force_comment_match_media: true,
  comment_templates: ["Full News:", "Full News:", "Full News:"],
  link_lists: {
    comment_links: [
      "https://dailyscope.x/a1",
      "https://dailyscope.x/a2",
      "https://dailyscope.x/CORRECT3",
    ],
    comment_link_mode: "random",
  },
  media_path: "C:/v/3-something.mp4",
});
check(
  "post_round 3 → 3rd bare link",
  String(bare.link || "").includes("CORRECT3"),
  bare.link + " " + bare.match_reason
);

// --- 6) Regression: media 5 must not get random link ---
const links5 = [
  "https://dailyscope.trendstorydaily.com/aaaa1",
  "https://dailyscope.trendstorydaily.com/bbbb2",
  "https://dailyscope.trendstorydaily.com/cccc3",
  "https://dailyscope.trendstorydaily.com/dddd4",
  "https://dailyscope.trendstorydaily.com/EEEEE5",
];
const a5 = assignCommentForPost({
  page_row_id: 3,
  pick_mode: "match_media",
  post_round: 5,
  comment_templates: ["Full News:"],
  link_lists: { comment_links: links5, comment_link_mode: "random" },
  media_path: "C:/v/5-1583681133509093.mp4",
});
check("media5 → link5 not random", String(a5.link).includes("EEEEE5"), a5.link);

console.log("\n--- login/auth smoke ---");
const bases = ["http://127.0.0.1:3847", "http://127.0.0.1:3000", "http://127.0.0.1:5173"];
let loginOk = false;
for (const base of bases) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(`${base}/auth/apps`, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json().catch(() => ({}));
    console.log("AUTH", base, r.status, Array.isArray(j.apps) ? `apps=${j.apps.length}` : JSON.stringify(j).slice(0, 80));
    if (r.ok) {
      loginOk = true;
      // import-token endpoint exists?
      const r2 = await fetch(`${base}/api/accounts/import-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "" }),
      });
      console.log("import-token empty →", r2.status, "(expect 4xx)");
      check("import-token route alive", r2.status >= 400 && r2.status < 500);
      break;
    }
  } catch (e) {
    console.log("AUTH skip", base, e.cause?.code || e.message);
  }
}
if (!loginOk) {
  console.log("WARN: app server not running — comment tests still ran; start app to live-check /auth/apps");
}

console.log(failed ? `\nFAILED ${failed}` : "\nALL COMMENT TESTS PASSED");
process.exit(failed ? 1 : 0);
