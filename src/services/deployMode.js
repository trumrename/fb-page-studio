/**
 * Deploy mode: portable desktop (default) vs central web server.
 *
 * central  — one host with your domain; clients only open the browser.
 * portable — each machine runs EXE + local 127.0.0.1 (+ optional Ngrok).
 */
import { config } from "../config.js";

export function getDeployMode() {
  const raw = String(
    process.env.DEPLOY_MODE || process.env.FB_DEPLOY_MODE || "portable"
  )
    .trim()
    .toLowerCase();
  if (raw === "central" || raw === "server" || raw === "web" || raw === "saas") {
    return "central";
  }
  return "portable";
}

export function isCentralDeploy() {
  return getDeployMode() === "central";
}

/** Hostname from APP_BASE_URL / FB_REDIRECT_URI (trusted public host). */
export function trustedPublicHostnames() {
  const hosts = new Set();
  for (const raw of [
    config.appBaseUrl,
    config.facebook?.redirectUri,
    process.env.TRUSTED_HOSTS || "",
  ]) {
    const text = String(raw || "").trim();
    if (!text) continue;
    if (text.includes(",")) {
      for (const part of text.split(",")) {
        const h = hostnameOf(part);
        if (h) hosts.add(h);
      }
      continue;
    }
    const h = hostnameOf(text);
    if (h) hosts.add(h);
  }
  return [...hosts];
}

function hostnameOf(value) {
  try {
    const s = String(value || "").trim();
    if (!s) return "";
    const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return String(url.hostname || "")
      .trim()
      .toLowerCase();
  } catch {
    return String(value || "")
      .replace(/^https?:\/\//i, "")
      .split("/")[0]
      .split(":")[0]
      .trim()
      .toLowerCase();
  }
}

export function getListenHost() {
  if (process.env.LISTEN_HOST) return process.env.LISTEN_HOST;
  // Central server must accept reverse-proxy / public NIC traffic
  return isCentralDeploy() ? "0.0.0.0" : "127.0.0.1";
}

/** Default: no ngrok on central (domain points at the server). */
/**
 * OAuth relay: Facebook → domain trung tâm → 127.0.0.1 (EXE local).
 * Không cần Ngrok trên máy khách; media/folder vẫn local.
 * Bật: OAUTH_RELAY=1 trong .env cạnh EXE.
 */
export function isOauthRelayMode() {
  const v = String(process.env.OAUTH_RELAY || process.env.OAUTH_MODE || "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "relay";
}

export function shouldAutostartNgrok() {
  if (String(process.env.NGROK_AUTOSTART || "").trim() !== "") {
    return String(process.env.NGROK_AUTOSTART) !== "0";
  }
  if (isCentralDeploy()) return false;
  if (isOauthRelayMode()) return false;
  return true;
}

export function getCentralAccessToken() {
  return String(process.env.CENTRAL_ACCESS_TOKEN || process.env.WEB_ACCESS_TOKEN || "").trim();
}

export function deployPublicInfo() {
  const relay = isOauthRelayMode();
  return {
    mode: getDeployMode(),
    central: isCentralDeploy(),
    oauth_relay: relay,
    listen_host: getListenHost(),
    app_base_url: config.appBaseUrl,
    oauth_redirect_uri: config.facebook.redirectUri,
    trusted_hosts: trustedPublicHostnames(),
    ngrok_autostart_default: shouldAutostartNgrok(),
    media_upload: isCentralDeploy() || process.env.ALLOW_MEDIA_UPLOAD === "1",
    access_token_required: Boolean(getCentralAccessToken()),
    client_hint: isCentralDeploy()
      ? "Khách chỉ mở domain trên trình duyệt — không cài server/Ngrok trên máy khách."
      : relay
        ? "EXE local + folder ảnh local. OAuth qua domain trung tâm — không Ngrok, không ngắt máy cũ."
        : "Chế độ portable: mỗi máy chạy EXE local (+ Ngrok nếu cần).",
  };
}
