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
assert(results[2].text == null, "page3 skipped — site A at cap 2");

// Site B still has room (different slug 1-other)
const b1 = assignCommentForPost({
  page_row_id: 201,
  comment_templates: ["see more :"],
  link_lists: { comment_links: all, comment_link_mode: "match_media" },
  media_path: "1-other.mp4",
  comment_site_tracker: tracker,
});
assert(b1.text && b1.comment_site === "othersite.com", "site B still comments");

console.log("tracker", tracker.snapshot());
console.log("ALL OK");
