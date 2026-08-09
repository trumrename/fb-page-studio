/**
 * Session-engine ops (cookie HTTP).
 *
 * Health check: implemented.
 * Publish/delete that need private Meta endpoints: registered as scaffold —
 * throw clear errors until endpoint maps are provided by local RE capture.
 *
 * We intentionally do NOT ship reverse-engineered GraphQL mutation documents.
 */
import { checkSessionHealth, sessionFetch } from "./sessionClient.js";
import { getFeature } from "./featureMatrix.js";

export class SessionOpNotMappedError extends Error {
  constructor(op, hint = "") {
    super(
      `[session] op "${op}" chưa map endpoint HTTP nội bộ.${hint ? ` ${hint}` : ""} ` +
        `Dùng mitmproxy/Charles bắt request khi làm tay trên app/web, rồi đăng ký vào sessionOps registry.`
    );
    this.code = "SESSION_OP_NOT_MAPPED";
    this.op = op;
  }
}

/** Optional pluggable handlers: op → async (payload, jobRow) => result */
const HANDLERS = new Map();

/**
 * Register a custom session op implementation (e.g. after local RE).
 * @param {string} op
 * @param {(payload: object, jobRow: object) => Promise<object>} fn
 */
export function registerSessionHandler(op, fn) {
  if (typeof fn !== "function") throw new Error("handler must be function");
  HANDLERS.set(op, fn);
}

export function listRegisteredSessionHandlers() {
  return [...HANDLERS.keys()];
}

/**
 * @param {string} op
 * @param {object} payload
 * @param {object} jobRow
 */
export async function runSessionOp(op, payload, jobRow) {
  const sessionId = Number(payload.session_id || jobRow.session_id);
  if (!sessionId && op !== "session_raw_http") {
    throw new Error("Thiếu session_id cho session engine");
  }

  if (HANDLERS.has(op)) {
    return HANDLERS.get(op)(payload, jobRow);
  }

  switch (op) {
    case "session_health": {
      const r = await checkSessionHealth(sessionId);
      return { engine: "session", ...r };
    }

    /** Escape hatch: authenticated HTTP GET/POST with stored cookie */
    case "session_raw_http": {
      if (!sessionId) throw new Error("session_raw_http cần session_id");
      const url = String(payload.url || "").trim();
      if (!/^https:\/\/([a-z0-9-]+\.)*(facebook|fbcdn|instagram)\.com\//i.test(url)) {
        throw new Error("session_raw_http chỉ cho phép host Meta/Facebook");
      }
      const r = await sessionFetch(sessionId, url, {
        method: payload.method || "GET",
        headers: payload.headers || {},
        body: payload.body || null,
        timeoutMs: payload.timeout_ms || 45000,
      });
      return {
        engine: "session",
        status: r.status,
        ok: r.ok,
        body_preview: String(r.body || "").slice(0, 2000),
      };
    }

    case "page_story_link_sticker":
      throw new SessionOpNotMappedError(
        op,
        "Cần map create story + link sticker (private). Tạm dùng graph combo/overlay."
      );

    case "group_post":
    case "group_list":
      throw new SessionOpNotMappedError(
        op,
        "Groups Graph API đã deprecate — bắt buộc session map."
      );

    case "group_delete_posts":
      throw new SessionOpNotMappedError(
        op,
        "Có thể nối service deleteGroupPosts hiện có khi sẵn session flow."
      );

    case "page_story_delete_schedule":
      throw new SessionOpNotMappedError(
        op,
        "Cần story_id + endpoint xóa story qua session/graph."
      );

    default: {
      const feat = getFeature(op);
      if (feat?.engine === "session" || feat?.engine === "hybrid") {
        throw new SessionOpNotMappedError(op);
      }
      throw new Error(`Session engine không nhận op: ${op}`);
    }
  }
}
