/**
 * Graph-engine executors — pure HTTP via existing facebook/publish/pageStories.
 */
import { getDb } from "../../db/index.js";
import { decryptToken } from "../crypto.js";
import { publishPageStoryWithLink } from "../pageStories.js";
import { publishPhoto, publishText, publishVideo } from "../publish.js";

function pageTokenForRow(pageRowId) {
  const row = getDb()
    .prepare(
      `SELECT p.*, a.meta_app_key
       FROM fb_pages p
       JOIN fb_accounts a ON a.id = p.account_id
       WHERE p.id = ?`
    )
    .get(Number(pageRowId));
  if (!row) throw new Error(`page_row_id ${pageRowId} không tồn tại`);
  const token = decryptToken(row.page_token_enc);
  if (!token) throw new Error("Page token rỗng");
  return { row, token, metaAppKey: row.meta_app_key || "app1" };
}

/**
 * @param {string} op
 * @param {object} payload
 * @param {object} jobRow
 */
export async function runGraphOp(op, payload, jobRow) {
  switch (op) {
    case "page_feed_post": {
      const { token, row } = pageTokenForRow(
        payload.page_row_id || jobRow.page_row_id
      );
      const pageId = payload.page_id || row.page_id;
      const kind = payload.kind || "text";
      if (kind === "photo") {
        const r = await publishPhoto(
          pageId,
          token,
          payload.media_path,
          payload.caption || ""
        );
        return { engine: "graph", kind, result: r };
      }
      if (kind === "video") {
        const r = await publishVideo(
          pageId,
          token,
          payload.media_path,
          payload.caption || ""
        );
        return { engine: "graph", kind, result: r };
      }
      const msg = [payload.caption || payload.message || "", payload.link || ""]
        .filter(Boolean)
        .join("\n\n");
      const r = await publishText(pageId, token, msg);
      return { engine: "graph", kind: "text", result: r };
    }

    case "page_story_media":
    case "page_story_combo_link":
    case "page_story_schedule": {
      const pageRowId = payload.page_row_id || jobRow.page_row_id;
      const { token, metaAppKey, row } = pageTokenForRow(pageRowId);
      const mode =
        payload.link_mode ||
        (op === "page_story_media"
          ? "media_only"
          : payload.link_url || payload.link
            ? "combo"
            : "media_only");
      const r = await publishPageStoryWithLink({
        pageId: payload.page_id || row.page_id,
        pageToken: token,
        filePath: payload.media_path,
        link: payload.link_url || payload.link || "",
        caption: payload.caption || "",
        link_mode: mode,
        metaAppKey,
      });
      return {
        engine: "graph",
        mode,
        result: r,
        story_id: r?.story?.post_id || r?.post_id || null,
      };
    }

    case "session_health":
      throw new Error("session_health is session engine only");

    default:
      throw new Error(`Graph engine chưa hỗ trợ op: ${op}`);
  }
}
