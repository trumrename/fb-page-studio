/**
 * LIVE Graph probe — list + optional delete on real Page tokens from AppData.
 *
 * Usage:
 *   set FB_USER_DIR=%APPDATA%\fb-page-studio
 *   node scripts/live-delete-probe.mjs              # list only (safe)
 *   node scripts/live-delete-probe.mjs --delete-one # delete 1 oldest shared/visitor if found
 *   node scripts/live-delete-probe.mjs --page-id=ID
 *   node scripts/live-delete-probe.mjs --full-wipe-dry # list wipe edges + branding plan only
 *
 * NEVER prints access tokens.
 */
import path from "path";
import fs from "fs";

// Point config at installed app data BEFORE importing config-dependent modules
const appData =
  process.env.FB_USER_DIR ||
  path.join(process.env.APPDATA || "", "fb-page-studio");
if (fs.existsSync(appData)) {
  process.env.FB_USER_DIR = appData;
  process.env.DATABASE_PATH =
    process.env.DATABASE_PATH || path.join(appData, "data", "app.db");
}

const { getDb } = await import("../src/db/index.js");
const { decryptToken } = await import("../src/services/crypto.js");
const {
  listPagePosts,
  deletePagePost,
  deletePageAvatarAndCover,
  graphGetSoft,
} = await import("../src/services/facebook.js");
// graphGet is private — use list + soft

const args = process.argv.slice(2);
const wantDeleteOne = args.includes("--delete-one");
const wantBrandingDry = args.includes("--branding-dry");
const wantBrandingDel = args.includes("--branding-delete");
const pageIdArg = (args.find((a) => a.startsWith("--page-id=")) || "").split(
  "="
)[1];
const nameArg = (args.find((a) => a.startsWith("--name=")) || "")
  .split("=")
  .slice(1)
  .join("=");

function mask(s) {
  const t = String(s || "");
  if (t.length < 12) return "***";
  return t.slice(0, 6) + "…" + t.slice(-4);
}

const report = {
  at: new Date().toISOString(),
  mode: wantDeleteOne
    ? "list+delete-one"
    : wantBrandingDel
      ? "list+branding-delete"
      : "list-only",
  pages: [],
  summary: { ok: 0, fail: 0, warns: [] },
};

console.log("\n========== LIVE DELETE PROBE ==========");
console.log("FB_USER_DIR:", process.env.FB_USER_DIR);
console.log("DB:", process.env.DATABASE_PATH);
console.log("Mode:", report.mode);
console.log("(tokens never printed)\n");

const db = getDb();
let pages = db
  .prepare(
    `SELECT p.id, p.page_id, p.name, p.status, p.page_token_enc, p.account_id,
            a.meta_app_key
     FROM fb_pages p
     LEFT JOIN fb_accounts a ON a.id = p.account_id
     WHERE p.page_token_enc IS NOT NULL AND p.page_token_enc != ''
     ORDER BY p.id DESC
     LIMIT 40`
  )
  .all();

if (pageIdArg) {
  pages = pages.filter((p) => String(p.page_id) === String(pageIdArg));
}
if (nameArg) {
  const q = nameArg.toLowerCase();
  pages = pages.filter((p) => String(p.name || "").toLowerCase().includes(q));
}

if (!pages.length) {
  console.error("No pages with tokens found.");
  process.exit(2);
}

// Prefer a page with activity; probe up to 5 pages until we get useful feed data
const maxPages = Math.min(5, pages.length);
const picked = pages.slice(0, maxPages);

for (const row of picked) {
  const pr = {
    page_row_id: row.id,
    page_id: row.page_id,
    name: row.name,
    meta_app_key: row.meta_app_key || "app1",
    edges: {},
    samples: { published: [], feed: [], share_like: [], visitor_like: [] },
    list_total: 0,
    list_by_source: {},
    delete_one: null,
    branding: null,
    errors: [],
  };
  console.log(`\n--- Page: ${row.name} (${row.page_id}) ---`);

  let token;
  try {
    token = decryptToken(row.page_token_enc);
    if (!token || token.length < 20) throw new Error("token decrypt empty/short");
    console.log("token:", mask(token), "len", token.length);
  } catch (e) {
    pr.errors.push("decrypt: " + e.message);
    console.error("decrypt FAIL", e.message);
    report.pages.push(pr);
    report.summary.fail++;
    continue;
  }

  // Token debug (no secret dump)
  try {
    const dbg = await graphGetSoft(
      "/debug_token",
      null,
      {
        input_token: token,
        access_token: token,
      },
      { metaAppKey: row.meta_app_key }
    );
    // debug_token often needs app token — ignore if fails
    if (dbg?.data) {
      pr.token_valid = dbg.data.is_valid;
      pr.token_scopes = (dbg.data.scopes || []).slice(0, 12);
      console.log(
        "token valid:",
        dbg.data.is_valid,
        "scopes:",
        (dbg.data.scopes || []).slice(0, 8).join(",")
      );
    }
  } catch {
    /* optional */
  }

  // Me/page probe
  try {
    const me = await graphGetSoft(
      `/${row.page_id}`,
      token,
      { fields: "id,name,fan_count,access_token" },
      { metaAppKey: row.meta_app_key }
    );
    if (me?.error) {
      pr.errors.push("page get: " + me.error.message);
      console.error("page GET error:", me.error.message, me.error.code);
    } else {
      console.log("page ok:", me?.name, "fans", me?.fan_count ?? "?");
    }
  } catch (e) {
    pr.errors.push("page get: " + e.message);
  }

  // List with wipe mode (includes feed/share/visitor)
  try {
    const posts = await listPagePosts(row.page_id, token, {
      maxPosts: 200,
      listMode: "wipe",
      listMaxAttempts: 2,
      metaAppKey: row.meta_app_key,
    });
    pr.list_total = posts.length;
    pr.edges = posts._edgeStats || {};
    pr.edge_errors = posts._edgeErrors || [];

    for (const p of posts) {
      const src = p._source || "unknown";
      pr.list_by_source[src] = (pr.list_by_source[src] || 0) + 1;
    }

    // Classify share / visitor-ish
    const shareLike = posts.filter((p) => {
      const st = String(p.status_type || p._source || "").toLowerCase();
      const msg = String(p.message || p.story || "").toLowerCase();
      return (
        /shared|share|shared_story|mobile_status_update/i.test(st) ||
        /shared a|đã chia sẻ|shared/i.test(msg) ||
        String(p._source || "").includes("feed")
      );
    });
    const fromFeed = posts.filter((p) =>
      String(p._source || "").startsWith("feed")
    );
    const visitorish = posts.filter((p) =>
      /visitor|tagged/i.test(String(p._source || ""))
    );

    pr.samples.share_like = shareLike.slice(0, 5).map((p) => ({
      id: p.id,
      source: p._source,
      status_type: p.status_type || null,
      created_time: p.created_time,
      message: String(p.message || p.story || "").slice(0, 80),
    }));
    pr.samples.feed = fromFeed.slice(0, 5).map((p) => ({
      id: p.id,
      source: p._source,
      created_time: p.created_time,
      message: String(p.message || p.story || "").slice(0, 80),
    }));
    pr.samples.visitor_like = visitorish.slice(0, 5).map((p) => ({
      id: p.id,
      source: p._source,
      created_time: p.created_time,
    }));

    console.log("list total:", posts.length);
    console.log("edge stats:", JSON.stringify(pr.edges));
    if (pr.edge_errors?.length) {
      console.log("edge errors:", pr.edge_errors.slice(0, 6).join(" | "));
    }
    console.log("by source:", JSON.stringify(pr.list_by_source));
    console.log(
      "feed items:",
      fromFeed.length,
      "share-like:",
      shareLike.length,
      "visitor/tagged:",
      visitorish.length
    );
    if (fromFeed[0]) {
      console.log(
        "sample feed:",
        fromFeed[0].id,
        String(fromFeed[0].message || "").slice(0, 60)
      );
    }
    if (shareLike[0]) {
      console.log(
        "sample share-like:",
        shareLike[0].id,
        String(shareLike[0].message || shareLike[0].story || "").slice(0, 60)
      );
    }

    // Optional: delete ONE oldest feed/share candidate (safest real delete test)
    if (wantDeleteOne) {
      const candidates = [...fromFeed, ...shareLike, ...posts].filter(
        (p) => p?.id
      );
      // prefer something that looks share/feed
      let target =
        shareLike.sort(
          (a, b) =>
            (Date.parse(a.created_time) || 0) - (Date.parse(b.created_time) || 0)
        )[0] ||
        fromFeed.sort(
          (a, b) =>
            (Date.parse(a.created_time) || 0) - (Date.parse(b.created_time) || 0)
        )[0] ||
        posts.sort(
          (a, b) =>
            (Date.parse(a.created_time) || 0) - (Date.parse(b.created_time) || 0)
        )[0];

      if (!target) {
        pr.delete_one = { ok: false, error: "no candidate" };
        console.log("DELETE-ONE: no candidate");
      } else {
        console.log(
          "DELETE-ONE attempt:",
          target.id,
          "source=",
          target._source,
          "time=",
          target.created_time
        );
        try {
          const r = await deletePagePost(target.id, token, {
            metaAppKey: row.meta_app_key,
          });
          pr.delete_one = {
            ok: true,
            id: target.id,
            source: target._source,
            response: r?.success === true || r?.success === "true" ? "success" : r,
          };
          console.log("DELETE-ONE OK", JSON.stringify(pr.delete_one.response));
          report.summary.ok++;
        } catch (e) {
          pr.delete_one = {
            ok: false,
            id: target.id,
            source: target._source,
            code: e.code,
            error: e.message,
          };
          console.error("DELETE-ONE FAIL", e.code, e.message);
          report.summary.fail++;
        }
      }
    } else {
      report.summary.ok++;
    }

    // Branding
    if (wantBrandingDry || wantBrandingDel) {
      if (wantBrandingDel) {
        console.log("BRANDING DELETE …");
        try {
          const br = await deletePageAvatarAndCover(row.page_id, token, {
            metaAppKey: row.meta_app_key,
          });
          pr.branding = br;
          console.log(
            "branding:",
            JSON.stringify({
              cover: br.cover,
              avatar: br.avatar,
              photos_deleted: br.photos_deleted,
              errors: (br.errors || []).slice(0, 3),
            })
          );
        } catch (e) {
          pr.branding = { error: e.message, code: e.code };
          console.error("branding FAIL", e.message);
        }
      } else {
        // dry: only fetch cover fields
        const page = await graphGetSoft(
          `/${row.page_id}`,
          token,
          { fields: "cover,picture" },
          { metaAppKey: row.meta_app_key }
        );
        pr.branding = {
          dry: true,
          has_cover_id: Boolean(page?.cover?.cover_id || page?.cover?.id),
          cover_id: page?.cover?.cover_id || page?.cover?.id || null,
          picture: page?.picture?.data?.url ? "present" : "none",
          error: page?.error?.message || null,
        };
        console.log("branding dry:", JSON.stringify(pr.branding));
      }
    }
  } catch (e) {
    pr.errors.push("list: " + e.message);
    console.error("LIST FAIL", e.message, e.code);
    report.summary.fail++;
  }

  report.pages.push(pr);
  // If we got a good list, can stop early for delete-one
  if (wantDeleteOne && pr.delete_one?.ok) break;
  if (!wantDeleteOne && pr.list_total > 0) {
    // still probe 1-2 pages for variety
    if (report.pages.filter((p) => p.list_total > 0).length >= 2) break;
  }
}

// Write report file (no tokens)
const outDir = path.join(process.cwd(), "Tổng Hợp Tool", "pack-dev");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "LIVE-DELETE-PROBE-REPORT.json");
fs.writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");

console.log("\n========== LIVE PROBE SUMMARY ==========");
console.log("pages probed:", report.pages.length);
console.log(
  "list totals:",
  report.pages.map((p) => `${p.name}:${p.list_total}`).join(" | ")
);
const anyFeed = report.pages.some(
  (p) => (p.list_by_source?.feed || 0) > 0 || Object.keys(p.list_by_source || {}).some((k) => k.startsWith("feed"))
);
const anyShare = report.pages.some((p) => (p.samples?.share_like || []).length > 0);
console.log("any feed-source items:", anyFeed);
console.log("any share-like samples:", anyShare);
console.log("delete_one:", report.pages.map((p) => p.delete_one).filter(Boolean));
console.log("report file:", outFile);

// Exit codes for CI gate
const listOk = report.pages.some((p) => p.list_total > 0 && !p.errors.some((e) => e.startsWith("list:")));
if (!listOk) {
  console.error("\nGATE FAIL: could not list any posts");
  process.exit(1);
}
if (wantDeleteOne) {
  const delOk = report.pages.some((p) => p.delete_one?.ok);
  if (!delOk) {
    console.error("\nGATE FAIL: delete-one did not succeed");
    process.exit(1);
  }
}
console.log("\nGATE PASS (for requested mode)");
process.exit(0);
