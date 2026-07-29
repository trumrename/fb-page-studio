/**
 * STRICT release gate for delete feature — must PASS before shipping Setup.
 *
 * Steps:
 *  1) Unit date-filter tests
 *  2) LIVE list (AppData tokens) — must list posts
 *  3) LIVE shared_story delete when available — must succeed
 *  4) Document permanent Meta limits (visitor_posts, tagged #200)
 *
 * Usage (from repo root):
 *   set FB_USER_DIR=%APPDATA%\fb-page-studio
 *   node scripts/release-gate-delete.mjs
 *
 * Exit 0 only if all hard gates pass.
 */
import { spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appData =
  process.env.FB_USER_DIR ||
  path.join(process.env.APPDATA || "", "fb-page-studio");
process.env.FB_USER_DIR = appData;
process.env.DATABASE_PATH =
  process.env.DATABASE_PATH || path.join(appData, "data", "app.db");
dotenv.config({ path: path.join(appData, ".env") });

const report = {
  at: new Date().toISOString(),
  version: JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
    .version,
  gates: [],
  meta_limits: [],
  pass: false,
};

function gate(name, ok, detail = "") {
  report.gates.push({ name, ok: !!ok, detail });
  console.log(ok ? "✓ GATE" : "✗ GATE FAIL", name, detail ? `— ${detail}` : "");
  return !!ok;
}

function runNode(script, args = []) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: 300_000,
  });
  return {
    code: r.status,
    out: (r.stdout || "") + (r.stderr || ""),
  };
}

console.log("\n######## RELEASE GATE DELETE v" + report.version + " ########\n");

// 1) Unit
{
  const r = runNode(path.join(root, "scripts/test-delete-date-filter.mjs"));
  gate("unit-date-filter", r.code === 0, r.code === 0 ? "PASS" : r.out.slice(-200));
}

// 2–3) Live list + share delete
{
  const { getDb } = await import("../src/db/index.js");
  const { decryptToken } = await import("../src/services/crypto.js");
  const { graphGetSoft, deletePagePost } = await import(
    "../src/services/facebook.js"
  );

  let pages = [];
  try {
    pages = getDb()
      .prepare(
        `SELECT page_id, name, page_token_enc FROM fb_pages
         WHERE page_token_enc IS NOT NULL AND page_token_enc != ''
         ORDER BY id DESC LIMIT 15`
      )
      .all();
  } catch (e) {
    gate("live-db", false, e.message);
  }

  gate("live-db", pages.length > 0, `${pages.length} pages with tokens`);

  let listedAny = false;
  let shareDeleted = false;
  let shareFound = false;
  let visitorBlocked = false;
  let taggedBlocked = false;

  for (const row of pages) {
    let token;
    try {
      token = decryptToken(row.page_token_enc);
    } catch {
      continue;
    }
    if (!token) continue;

    const pub = await graphGetSoft(
      `/${row.page_id}/published_posts`,
      token,
      {
        fields: "id,created_time,status_type,message,story",
        limit: 50,
      },
      {}
    );
    if (!pub.ok) {
      console.log("  skip", row.name, pub.code, pub.error);
      continue;
    }
    const data = pub.data?.data || [];
    if (data.length) listedAny = true;
    const shares = data.filter((p) => p.status_type === "shared_story");
    console.log(
      `  ${row.name}: published ${data.length}, shared_story ${shares.length}`
    );

    // visitor
    const vis = await graphGetSoft(
      `/${row.page_id}/visitor_posts`,
      token,
      { fields: "id", limit: 5 },
      {}
    );
    if (!vis.ok && (vis.code === 200 || /permission/i.test(String(vis.error)))) {
      visitorBlocked = true;
    }

    // tagged sample delete capability
    const tag = await graphGetSoft(
      `/${row.page_id}/tagged`,
      token,
      { fields: "id", limit: 1 },
      {}
    );
    if (tag.ok && tag.data?.data?.[0]?.id) {
      try {
        await deletePagePost(tag.data.data[0].id, token, {});
      } catch (e) {
        if (e.code === 200 || /disabled|permission|disabled/i.test(e.message)) {
          taggedBlocked = true;
        }
      }
    }

    if (shares.length && !shareDeleted) {
      shareFound = true;
      const target = shares[shares.length - 1];
      console.log("  LIVE delete shared_story", target.id, "on", row.name);
      try {
        const del = await deletePagePost(target.id, token, {});
        const ok =
          del?.success === true ||
          del?.success === "true" ||
          del === true;
        if (ok) {
          // verify
          await new Promise((r) => setTimeout(r, 1200));
          const chk = await graphGetSoft(
            `/${target.id}`,
            token,
            { fields: "id" },
            {}
          );
          if (!chk.ok) {
            shareDeleted = true;
            console.log("  shared_story DELETE+VERIFY OK");
          } else {
            console.log("  shared_story delete returned success but still readable");
          }
        }
      } catch (e) {
        console.log("  shared_story DELETE FAIL", e.code, e.message);
      }
    }

    if (listedAny && (shareDeleted || !shareFound)) {
      // keep scanning for share if not found yet
      if (shareDeleted) break;
    }
  }

  gate("live-list-posts", listedAny, listedAny ? "listed OK" : "no posts listed");
  if (shareFound) {
    gate(
      "live-delete-shared-story",
      shareDeleted,
      shareDeleted ? "DELETE shared_story OK" : "found shares but delete failed"
    );
  } else {
    // Soft fail: no shares to test — mark warn but do not block if list works
    report.gates.push({
      name: "live-delete-shared-story",
      ok: true,
      detail: "SKIP — no shared_story in first pages (list still required)",
      skip: true,
    });
    console.log("✓ GATE live-delete-shared-story — SKIP (no shared_story found)");
  }

  if (visitorBlocked) {
    report.meta_limits.push(
      "visitor_posts: #200 Permissions — cần pages_read_user_content / App Review"
    );
  }
  if (taggedBlocked) {
    report.meta_limits.push(
      "tagged posts DELETE: often #200 (app publishing disabled / not owned by page)"
    );
  }
  report.meta_limits.push(
    "photos not created by app: Meta #200 permanent fail"
  );
  report.meta_limits.push(
    "avatar/cover DELETE needs MANAGE + photo node; NPE may block"
  );
}

const hardFails = report.gates.filter((g) => !g.ok && !g.skip);
report.pass = hardFails.length === 0;

const out = path.join(
  root,
  "Tổng Hợp Tool",
  "pack-dev",
  "RELEASE-GATE-DELETE.json"
);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2), "utf8");

console.log("\n######## GATE RESULT:", report.pass ? "PASS" : "FAIL", "########");
console.log("report:", out);
if (report.meta_limits.length) {
  console.log("\nMeta limits (not tool bugs):");
  for (const m of report.meta_limits) console.log(" -", m);
}
process.exit(report.pass ? 0 : 1);
