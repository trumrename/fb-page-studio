/**
 * When OAUTH_RELAY=1, pull live Public URL + Redirect URI from the OAuth relay
 * so internal EXEs follow the server domain without hand-editing .env.
 *
 * Tries known hosts (modelswiki.top first) then OAUTH_RELAY_URL / bootstrap list.
 * Never overwrites APP_BASE_URL (stays 127.0.0.1 for portable EXE).
 */
import fs from "fs";
import path from "path";
import { config } from "../config.js";
import { getEnvPath } from "../paths.js";
import { isOauthRelayMode } from "./deployMode.js";

/** Primary relay used when pack still has an old domain in .env */
const PRIMARY_RELAY = "https://modelswiki.top";

function writeEnvValues(envPath, values) {
  const exists = fs.existsSync(envPath);
  let text = exists ? fs.readFileSync(envPath, "utf8") : "";
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  for (const [key, value] of Object.entries(values)) {
    const safeValue = String(value ?? "");
    if (/[\r\n]/.test(safeValue)) continue;
    const pattern = new RegExp(`^(\\s*${key}\\s*=).*?$`, "m");
    if (pattern.test(text)) text = text.replace(pattern, (_m, prefix) => `${prefix}${safeValue}`);
    else text += `${text && !text.endsWith("\n") ? newline : ""}${key}=${safeValue}${newline}`;
  }
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, text, "utf8");
}

function normalizeBase(raw) {
  let s = String(raw || "").trim().replace(/\/$/, "");
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname || u.hostname === "localhost" || u.hostname === "127.0.0.1") return "";
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

function candidateBases() {
  const list = [];
  const push = (v) => {
    const b = normalizeBase(v);
    if (b && !list.includes(b)) list.push(b);
  };
  // Prefer live production domain so old packs (videoviral1 / ngrok) self-heal.
  push(PRIMARY_RELAY);
  push(process.env.OAUTH_RELAY_URL);
  push(process.env.RELAY_PUBLIC_URL);
  const bootstrap = String(process.env.OAUTH_RELAY_BOOTSTRAP || "").trim();
  if (bootstrap) {
    for (const part of bootstrap.split(/[,;\s]+/)) push(part);
  }
  // Last: whatever was saved as redirect host (may be stale)
  try {
    const redir = String(process.env.FB_REDIRECT_URI || config.facebook?.redirectUri || "").trim();
    if (redir) push(new URL(redir).origin);
  } catch {
    /* ignore */
  }
  return list;
}

async function fetchClientConfig(base) {
  const paths = ["/client-config", "/api/client-config", "/health", "/api/health"];
  for (const p of paths) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(`${base}${p}`, {
        signal: ctrl.signal,
        headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      });
      clearTimeout(t);
      if (!res.ok) continue;
      const data = await res.json();
      if (!data || data.ok === false) continue;
      // Require relay markers so we don't adopt a random website
      if (data.service && data.service !== "fb-page-studio-oauth-relay") continue;
      if (!data.public_url && !data.redirect_uri && data.exchange === undefined && !data.oauth_relay) {
        // Old /health without public_url — treat base as public if service matches
        if (data.service === "fb-page-studio-oauth-relay") {
          return {
            public_url: base,
            redirect_uri: `${base}/auth/facebook/callback`,
            exchange: Boolean(data.exchange),
            apps: Array.isArray(data.apps) ? data.apps : [],
          };
        }
        continue;
      }
      const publicUrl = normalizeBase(data.public_url || base);
      const redirect =
        String(data.redirect_uri || "").trim() ||
        `${publicUrl}/auth/facebook/callback`;
      if (!publicUrl) continue;
      return {
        public_url: publicUrl,
        redirect_uri: redirect,
        exchange: Boolean(data.exchange),
        apps: Array.isArray(data.apps) ? data.apps : [],
      };
    } catch {
      /* try next path / host */
    }
  }
  return null;
}

/**
 * @returns {Promise<{ synced: boolean, public_url?: string, redirect_uri?: string, from?: string, error?: string }>}
 */
export async function syncOauthRelayConfig() {
  if (!isOauthRelayMode()) {
    return { synced: false, error: "OAUTH_RELAY off" };
  }
  if (String(process.env.OAUTH_RELAY_SYNC || "1").trim() === "0") {
    return { synced: false, error: "OAUTH_RELAY_SYNC=0" };
  }

  const candidates = candidateBases();
  if (!candidates.length) {
    return { synced: false, error: "no relay candidates" };
  }

  let found = null;
  let from = "";
  for (const base of candidates) {
    const cfg = await fetchClientConfig(base);
    if (cfg?.public_url) {
      found = cfg;
      from = base;
      break;
    }
  }

  if (!found) {
    console.warn(
      `[oauth-relay] Không liên lạc được relay. Đã thử: ${candidates.join(", ")}. ` +
        `Giữ .env hiện tại. Kiểm tra máy server + https://modelswiki.top/health`
    );
    return { synced: false, error: "relay unreachable", tried: candidates };
  }

  const publicUrl = found.public_url.replace(/\/$/, "");
  const redirectUri = found.redirect_uri || `${publicUrl}/auth/facebook/callback`;
  const prevRedirect = String(process.env.FB_REDIRECT_URI || config.facebook.redirectUri || "").trim();
  const prevRelay = String(process.env.OAUTH_RELAY_URL || "").trim().replace(/\/$/, "");

  // Public app catalog from server (full app_id, no secrets)
  let remoteApps = Array.isArray(found.apps) ? found.apps : [];
  if (!remoteApps.length) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const ar = await fetch(`${publicUrl}/api/apps`, {
        signal: ctrl.signal,
        headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      });
      clearTimeout(t);
      if (ar.ok) {
        const aj = await ar.json();
        if (Array.isArray(aj.apps)) remoteApps = aj.apps;
      }
    } catch {
      /* optional */
    }
  }

  const envUpdates = {
    OAUTH_RELAY: "1",
    OAUTH_RELAY_URL: publicUrl,
    FB_REDIRECT_URI: redirectUri,
    NGROK_AUTOSTART: "0",
    APP_BASE_URL: String(
      process.env.APP_BASE_URL || `http://127.0.0.1:${config.port || 3847}`
    ),
  };

  // Auto-fill FB_APP_ID / _2 / _3… from server so every machine matches without hand-edit
  let appsChanged = false;
  for (const a of remoteApps) {
    const key = String(a.key || "").trim();
    const id = String(a.app_id || a.appId || "").trim();
    const name = String(a.name || "").trim();
    if (!key || !/^\d{5,30}$/.test(id)) continue;
    const m = /^app(\d+)$/i.exec(key);
    if (!m) continue;
    const n = Number(m[1]);
    const idKey = n <= 1 ? "FB_APP_ID" : `FB_APP_ID_${n}`;
    const nameKey = n <= 1 ? "FB_APP_NAME" : `FB_APP_NAME_${n}`;
    const redirKey = n <= 1 ? "FB_REDIRECT_URI" : `FB_REDIRECT_URI_${n}`;
    const prevId = String(process.env[idKey] || "").trim();
    if (prevId !== id) appsChanged = true;
    envUpdates[idKey] = id;
    if (name) envUpdates[nameKey] = name;
    envUpdates[redirKey] = redirectUri;
    process.env[idKey] = id;
    if (name) process.env[nameKey] = name;
    // Never pull secrets from server onto client
  }

  const changed = prevRedirect !== redirectUri || prevRelay !== publicUrl || appsChanged;

  process.env.OAUTH_RELAY_URL = publicUrl;
  process.env.FB_REDIRECT_URI = redirectUri;
  // Portable EXE must keep local bind for media/UI — never set APP_BASE_URL to public domain.
  if (
    !String(process.env.APP_BASE_URL || "").includes("127.0.0.1") &&
    !String(process.env.APP_BASE_URL || "").includes("localhost")
  ) {
    process.env.APP_BASE_URL = `http://127.0.0.1:${config.port || 3847}`;
    config.appBaseUrl = process.env.APP_BASE_URL;
    envUpdates.APP_BASE_URL = process.env.APP_BASE_URL;
  }
  config.facebook.redirectUri = redirectUri;
  if (envUpdates.FB_APP_ID) {
    config.facebook.appId = envUpdates.FB_APP_ID;
  }

  if (changed) {
    try {
      writeEnvValues(getEnvPath(), envUpdates);
      console.log(
        `[oauth-relay] Đồng bộ từ ${from}: domain=${publicUrl}` +
          (remoteApps.length ? ` · ${remoteApps.length} Meta App` : "")
      );
    } catch (e) {
      console.warn("[oauth-relay] Ghi .env thất bại (vẫn dùng memory):", e.message);
    }
  } else {
    console.log(`[oauth-relay] Domain + apps đã khớp server: ${publicUrl}`);
  }

  return {
    synced: true,
    public_url: publicUrl,
    redirect_uri: redirectUri,
    from,
    changed,
    apps: remoteApps,
  };
}
