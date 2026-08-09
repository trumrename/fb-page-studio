/**
 * Route op → graph | session HTTP engine.
 */
import { getFeature } from "./featureMatrix.js";
import { runGraphOp } from "./graphOps.js";
import { runSessionOp } from "./sessionOps.js";

/**
 * @param {object} jobRow http_ops_queue row
 */
export async function executeJob(jobRow) {
  const op = String(jobRow.op || "").trim();
  let payload = {};
  try {
    payload = JSON.parse(jobRow.payload_json || "{}");
  } catch {
    payload = {};
  }

  const feature = getFeature(op);
  let engine = String(jobRow.engine || feature?.engine || "graph").toLowerCase();

  // Hybrid: prefer graph for story schedule unless forced session / sticker mode
  if (engine === "hybrid" || feature?.engine === "hybrid") {
    if (
      payload.force_session ||
      payload.link_mode === "sticker" ||
      op === "page_story_link_sticker"
    ) {
      engine = "session";
    } else {
      engine = "graph";
    }
  }

  if (engine === "session") {
    return runSessionOp(op, payload, jobRow);
  }
  return runGraphOp(op, payload, jobRow);
}
