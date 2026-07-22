/**
 * Customer machine: push Meta App ID + Secret to OAuth relay.
 * Secret is stored only on server (data/apps.json); client keeps App ID for Connect.
 */
import { config } from "../config.js";
import { isOauthRelayMode } from "./deployMode.js";

function relayBase() {
  let s = String(
    process.env.OAUTH_RELAY_URL || process.env.RELAY_PUBLIC_URL || ""
  )
    .trim()
    .replace(/\/$/, "");
  if (!s) {
    try {
      s = new URL(config.facebook?.redirectUri || process.env.FB_REDIRECT_URI || "").origin;
    } catch {
      s = "";
    }
  }
  return s;
}

function pushToken() {
  return String(
    process.env.RELAY_ADMIN_TOKEN ||
      process.env.OAUTH_RELAY_PUSH_TOKEN ||
      process.env.RELAY_REGISTER_TOKEN ||
      ""
  ).trim();
}

/**
 * @param {{ appId: string, appSecret: string, name?: string, key?: string }} app
 * @returns {Promise<{ ok: boolean, key?: string, error?: string, apps?: unknown[] }>}
 */
export async function pushMetaAppToRelay(app) {
  if (!isOauthRelayMode()) {
    return { ok: false, error: "OAUTH_RELAY chưa bật" };
  }
  const base = relayBase();
  if (!base) return { ok: false, error: "Thiếu OAUTH_RELAY_URL" };
  // Token optional when server has RELAY_ALLOW_OPEN_REGISTER=1
  const token = pushToken();
  const appId = String(app.appId || "").trim();
  const appSecret = String(app.appSecret || "").trim();
  if (!/^\d{5,30}$/.test(appId)) return { ok: false, error: "App ID không hợp lệ" };
  if (appSecret.length < 16) return { ok: false, error: "App Secret quá ngắn" };

  try {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (token) headers["X-Relay-Admin-Token"] = token;
    const res = await fetch(`${base}/api/admin/apps`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        app_id: appId,
        app_secret: appSecret,
        name: app.name || undefined,
        key: app.key || undefined,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) {
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    }
    return {
      ok: true,
      key: body.key,
      apps: body.apps,
      message: body.message,
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}
