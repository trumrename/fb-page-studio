import {
  extractCommentSite,
  createCommentSiteTracker,
  assignCommentForPost,
} from "../src/services/mediaLibrary.js";

function assert(c, m) {
  if (!c) {
    console.error("FAIL", m);
    process.exit(1);
  }
  console.log("PASS", m);
}

assert(
  extractCommentSite("https://profiles.dailypulsepost.com/1-natalie/") ===
    "profiles.dailypulsepost.com",
  "site A"
);
assert(extractCommentSite("https://www.othersite.com/1-foo/") === "othersite.com", "strip www");

const linksA = [1, 2, 3].map((i) => `https://profiles.dailypulsepost.com/${i}-person/`);
const linksB = [1, 2, 3].map((i) => `https://othersite.com/${i}-other/`);
const all = [...linksA, ...linksB];
const tracker = createCommentSiteTracker(2);

const results = [];
for (let i = 0; i < 3; i++) {
  results.push(
    assignCommentForPost({
      page_row_id: 101 + i,
      comment_templates: ["see more :"],
      link_lists: {
        comment_links: all,
        comment_link_mode: "match_media",
        comment_max_pages_per_site: 2,
      },
      media_path: `${i + 1}-person.mp4`,
      comment_site_tracker: tracker,
    })
  );
}
assert(results[0].text && results[0].comment_site === "profiles.dailypulsepost.com", "page1 ok");
assert(results[1].text && results[1].comment_site === "profiles.dailypulsepost.com", "page2 ok");
// Site A đã đủ 2 page → page3 lấy link site B (không để trống comment)
assert(results[2].text && results[2].comment_site === "othersite.com", "page3 fallback site B when A at cap");
assert(results[2].match_reason === "slug_exact" || results[2].link, "page3 still has a link");

// Slug không khớp → vẫn lấy link khác còn slot (tracker riêng)
const trackerMiss = createCommentSiteTracker(10);
const miss = assignCommentForPost({
  page_row_id: 301,
  comment_templates: ["see more :"],
  link_lists: { comment_links: all, comment_link_mode: "match_media" },
  media_path: "zzz-unknown-media.mp4",
  comment_site_tracker: trackerMiss,
});
assert(miss.text && miss.link, "match miss → fallback other link (not empty)");

// Exact slug site B trên tracker còn chỗ
const trackerB = createCommentSiteTracker(2);
const b1 = assignCommentForPost({
  page_row_id: 201,
  comment_templates: ["see more :"],
  link_lists: { comment_links: all, comment_link_mode: "match_media" },
  media_path: "1-other.mp4",
  comment_site_tracker: trackerB,
});
assert(b1.text && b1.comment_site === "othersite.com", "site B exact slug comments");

// Cả 2 site đã đủ cap → mới skip
const trackerFull = createCommentSiteTracker(1);
assignCommentForPost({
  page_row_id: 1,
  comment_templates: ["see more :"],
  link_lists: { comment_links: linksA, comment_link_mode: "match_media" },
  media_path: "1-person.mp4",
  comment_site_tracker: trackerFull,
});
assignCommentForPost({
  page_row_id: 2,
  comment_templates: ["see more :"],
  link_lists: { comment_links: linksB, comment_link_mode: "match_media" },
  media_path: "1-other.mp4",
  comment_site_tracker: trackerFull,
});
const bothFull = assignCommentForPost({
  page_row_id: 3,
  comment_templates: ["see more :"],
  link_lists: { comment_links: all, comment_link_mode: "match_media" },
  media_path: "2-person.mp4",
  comment_site_tracker: trackerFull,
});
assert(bothFull.text == null && !bothFull.link, "all sites at cap → skip comment");

console.log("tracker", tracker.snapshot());
console.log("ALL OK");
