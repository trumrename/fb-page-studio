/**
 * Regression: video-only không đòi ảnh; comment apply không mất link có số;
 * all_pages media req; resolvePlannedPostType.
 * KHÔNG đụng server sống — pure unit.
 */
import assert from "assert";
import { resolvePlannedPostType, normalizeSettings } from "../src/services/rotationPlan.js";
import {
  assignCommentForPost,
  pickLinkByMediaOrdinal,
} from "../src/services/mediaLibrary.js";

let failed = 0;
function check(name, ok, detail = "") {
  if (ok) console.log("PASS", name);
  else {
    failed++;
    console.error("FAIL", name, detail);
  }
}

// 1) Chọn video → không bao giờ ra photo khi không phải pattern
{
  const s = normalizeSettings({ post_type: "video", media_pattern_mode: "page_sequence" });
  const t0 = resolvePlannedPostType(s, { sequence: ["photo", "video", "text"] }, 0);
  const t1 = resolvePlannedPostType(s, { sequence: ["photo", "video", "text"] }, 1);
  check("video beats page_sequence round0", t0 === "video", t0);
  check("video beats page_sequence round1", t1 === "video", t1);
}

{
  const s = normalizeSettings({ post_type: "video", media_pattern_mode: "fixed" });
  check("fixed video", resolvePlannedPostType(s, {}, 0) === "video");
}

{
  const s = normalizeSettings({
    post_type: "auto",
    media_pattern_mode: "pattern",
    media_pattern: "photo,video",
  });
  check("pattern still photo then video", resolvePlannedPostType(s, {}, 0) === "photo");
  check("pattern round1 video", resolvePlannedPostType(s, {}, 1) === "video");
}

// 2) Numbered links preserved conceptually (pick by ordinal)
{
  const lines = [
    "1. https://www.facebook.com/reel/111/",
    "2. https://www.facebook.com/reel/222/",
    "9. https://www.facebook.com/reel/1376182584691551/",
  ];
  const p = pickLinkByMediaOrdinal(lines, "9-x.mp4");
  check("numbered link not lost for match", p.url?.includes("1376182584691551"), p.reason);
}

// 3) Comment assign keeps prefix text + correct link; random mode forced by pick_mode
{
  const r = assignCommentForPost({
    page_row_id: 1,
    pick_mode: "match_media",
    post_round: 2,
    comment_templates: ["1. Hello one", "2. Hello two opener"],
    link_lists: {
      comment_link_mode: "random",
      comment_links: [
        "1. https://example.com/a",
        "2. https://example.com/b-CORRECT",
      ],
    },
    media_path: "C:/v/2-file.mp4",
  });
  check("prefix stripped of number", r.text?.startsWith("Hello two"), r.text);
  check("link matches media 2", r.link?.includes("b-CORRECT"), r.link);
}

// 4) all_pages normalize
{
  const s = normalizeSettings({ media_reuse: "all_pages", post_type: "video" });
  check("media_reuse all_pages", s.media_reuse === "all_pages");
  check("post_type video kept", s.post_type === "video");
}

console.log(failed ? `\nFAILED ${failed}` : "\nALL MODE REGRESSION PASSED");
process.exit(failed ? 1 : 0);
