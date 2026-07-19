import fs from "fs";
import os from "os";
import path from "path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fbps-caption-pool-"));
let database = null;
process.env.DATABASE_PATH = path.join(tempRoot, "data", "app.db");
process.env.FB_USER_DIR = tempRoot;
process.env.FB_EXE_DIR = tempRoot;
process.env.NGROK_AUTOSTART = "0";

try {
  const { getDb } = await import("../src/db/index.js");
  const { captionPoolIdentity, reserveCaptionSlot } = await import(
    "../src/services/captionPoolState.js"
  );
  const db = getDb();
  database = db;
  const account = db
    .prepare(
      `INSERT INTO fb_accounts
       (fb_user_id, meta_app_key, name, user_token_enc)
       VALUES ('caption-test-user', 'app1', 'Caption Admin', 'x')`
    )
    .run();
  const addPage = db.prepare(
    `INSERT INTO fb_pages
     (account_id, page_id, name, page_token_enc, status)
     VALUES (?, ?, ?, 'x', 'active')`
  );
  const page1 = addPage.run(account.lastInsertRowid, "caption-page-1", "Caption Page 1");
  const page2 = addPage.run(account.lastInsertRowid, "caption-page-2", "Caption Page 2");
  const folder = path.join(tempRoot, "captions");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, "captions.txt"),
    "Caption A\nCaption B\nCaption C\n",
    "utf8"
  );
  db.prepare(
    `INSERT INTO page_post_config
     (page_row_id, captions_folder, caption_slot_index)
     VALUES (?, ?, ?)`
  ).run(page1.lastInsertRowid, folder, 4);
  db.prepare(
    `INSERT INTO page_post_config
     (page_row_id, captions_folder, caption_slot_index)
     VALUES (?, ?, ?)`
  ).run(page2.lastInsertRowid, folder, 7);

  const input1 = { captionsFolder: folder, captions: [], pageRowId: page1.lastInsertRowid };
  const input2 = { captionsFolder: folder, captions: [], pageRowId: page2.lastInsertRowid };
  const identity1 = captionPoolIdentity(input1);
  const identity2 = captionPoolIdentity(input2);
  if (identity1.key !== identity2.key) throw new Error("Shared folder produced different pool keys");

  const slots = [
    reserveCaptionSlot(input1).slot_index,
    reserveCaptionSlot(input2).slot_index,
    reserveCaptionSlot(input1).slot_index,
  ];
  if (slots.join(",") !== "7,8,9") {
    throw new Error(`Shared caption cursor mismatch: ${slots.join(",")}`);
  }

  const { getCaptionStats } = await import("../src/services/poster.js");
  const { recordCaption } = await import("../src/services/antiSpam.js");
  const before = getCaptionStats({ captions_folder: folder, captions: [] });
  if (before.total !== 3 || before.available !== 3) {
    throw new Error(`Caption availability before success mismatch: ${JSON.stringify(before)}`);
  }
  recordCaption("Caption A", page1.lastInsertRowid, "caption-page-1");
  const after = getCaptionStats({ captions_folder: folder, captions: [] });
  if (after.total !== 3 || after.available !== 2 || after.used_recent !== 1) {
    throw new Error(`Caption success note mismatch: ${JSON.stringify(after)}`);
  }

  const inlineA = captionPoolIdentity({ captions: ["A", "B"], pageRowId: 1 });
  const inlineB = captionPoolIdentity({ captions: ["A", "B"], pageRowId: 2 });
  if (inlineA.key !== inlineB.key) throw new Error("Same inline pool did not share identity");

  console.log(
    "CAPTION POOL PASS: shared slots " + slots.join(" → ") +
      ` · available ${before.available} → ${after.available} after success note`
  );
} finally {
  try {
    database?.close();
  } catch {
    // best-effort cleanup for Windows file locks
  }
  const resolved = path.resolve(tempRoot);
  if (
    resolved.startsWith(path.resolve(os.tmpdir())) &&
    path.basename(resolved).startsWith("fbps-caption-pool-")
  ) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
