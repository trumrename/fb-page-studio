/**
 * Unit tests for delete date-range filter (no server).
 * node scripts/test-delete-date-filter.mjs
 */
import {
  toUnixSeconds,
  postInTimeRange,
  filterPostsByOptions,
  hasContentFilters,
  isBrandingGraphItem,
} from "../src/services/deletePosts.js";

let fails = 0;
function assert(cond, name) {
  if (cond) console.log("✓", name);
  else {
    console.error("✗", name);
    fails++;
  }
}

// until = 2026-07-15 23:59 local-ish via ISO
const until = toUnixSeconds("2026-07-15T23:59:00");
const since = toUnixSeconds("2026-07-01T00:00:00");
assert(until != null && since != null, "parse since/until");

const posts = [
  { id: "1", created_time: "2026-06-30T12:00:00+0000", message: "old" },
  { id: "2", created_time: "2026-07-10T12:00:00+0000", message: "in range" },
  { id: "3", created_time: "2026-07-20T12:00:00+0000", message: "after until" },
  { id: "4", created_time: null, message: "no time" },
  { id: "5", created_time: "2026-07-15T16:00:00+0000", message: "on until day" },
];

// only until
{
  const f = filterPostsByOptions(posts, { until });
  const ids = f.map((p) => p.id).sort();
  // posts after until must not appear
  assert(!ids.includes("3"), "until excludes posts after end date");
  assert(ids.includes("2"), "until keeps in-range posts");
  assert(!ids.includes("4"), "until drops posts without created_time");
}

// since + until
{
  const f = filterPostsByOptions(posts, { since, until });
  const ids = f.map((p) => p.id);
  assert(!ids.includes("1"), "since excludes before");
  assert(ids.includes("2"), "range keeps middle");
  assert(!ids.includes("3"), "range excludes after");
}

assert(hasContentFilters({ until: until }), "hasContentFilters with until");
assert(hasContentFilters({ since: since }), "hasContentFilters with since");
assert(!hasContentFilters({ max_posts: 0 }), "no filters = full wipe ok");
assert(
  hasContentFilters({ keyword: "x" }),
  "keyword is content filter"
);

// postInTimeRange inclusive until
assert(
  postInTimeRange(
    { created_time: new Date(until * 1000).toISOString() },
    null,
    until
  ),
  "until inclusive at exact second"
);
assert(
  !postInTimeRange(
    { created_time: new Date((until + 1) * 1000).toISOString() },
    null,
    until
  ),
  "until exclusive after +1s"
);

// Branding (avatar / profile picture) — never in bulk list by default
assert(
  isBrandingGraphItem({
    id: "1",
    story: "Beautiful Women Daily updated their profile picture.",
  }),
  "story profile picture is branding"
);
assert(
  isBrandingGraphItem({
    id: "2",
    status_type: "added_profile_picture",
  }),
  "status_type added_profile_picture is branding"
);
assert(
  isBrandingGraphItem({
    id: "3",
    album: { type: "profile", name: "Profile Pictures" },
  }),
  "album type=profile is branding"
);
assert(
  !isBrandingGraphItem({
    id: "4",
    message: "sale photo",
    status_type: "added_photos",
  }),
  "normal added_photos is NOT branding"
);
{
  const mixed = [
    { id: "a", story: "X updated their profile picture." },
    { id: "b", message: "hello", created_time: "2026-07-10T12:00:00+0000" },
    { id: "c", album: { type: "cover", name: "Cover Photos" } },
  ];
  const f = filterPostsByOptions(mixed, {});
  assert(f.length === 1 && f[0].id === "b", "filter drops branding by default");
  const keep = filterPostsByOptions(mixed, { include_branding: true });
  assert(keep.length === 3, "include_branding keeps all");
}

if (fails) {
  console.error("\nFAILED", fails);
  process.exit(1);
}
console.log("\nDELETE DATE FILTER PASS");
process.exit(0);
