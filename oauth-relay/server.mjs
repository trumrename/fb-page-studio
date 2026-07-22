/**
 * OAuth Relay — domain công khai, EXE local không cần Ngrok.
 *
 * Modes:
 * 1) REDIRECT (mặc định, gói nội bộ có secret trên EXE):
 *    FB → relay → 302 → http://127.0.0.1:PORT/auth/facebook/callback?code&state
 *
 * 2) EXCHANGE (gói khách, secret CHỈ trên relay):
 *    RELAY_EXCHANGE=1 + FB_APP_ID + FB_APP_SECRET
 *    FB → relay đổi code → ticket → 302 →
 *    http://127.0.0.1:PORT/auth/facebook/relay-complete?ticket=
 *
 * State từ EXE: nanoid.port.metaAppKey  (vd. xxx.3847.app1)
 */
import http from "http";
import { URL } from "url";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load .env next to relay or project root
for (const p of [
  path.join(__dirname, ".env"),
  path.join(__dirname, "..", ".env"),
  path.join(__dirname, "..", "oauth-relay.env"),
]) {
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]]) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

const listenPort = Number(process.env.PORT || process.env.RELAY_PORT || 8080);
const listenHost = process.env.LISTEN_HOST || "0.0.0.0";
const defaultLocalPort = Number(process.env.DEFAULT_LOCAL_PORT || 3847);
const publicName =
  process.env.RELAY_PUBLIC_URL ||
  process.env.OAUTH_RELAY_URL ||
  "(cấu hình domain Nginx)";
const exchangeMode =
  String(process.env.RELAY_EXCHANGE || "").trim() === "1" ||
  String(process.env.RELAY_EXCHANGE || "").toLowerCase() === "true";

const tickets = new Map(); // ticket -> { access_token, expires_in, meta_app_key, app_id, exp }
const TICKET_TTL_MS = 120_000;

function parseState(state) {
  const s = String(state || "");
  const parts = s.split(".");
  let port = defaultLocalPort;
  let metaAppKey = "app1";
  let appId = "";
  if (parts.length >= 2) {
    const maybePort = Number(parts[1]);
    if (Number.isFinite(maybePort) && maybePort >= 1024 && maybePort <= 65535) {
      port = maybePort;
    }
  }
  if (parts.length >= 3) {
    const k = parts[2];
    if (k === "app1" || k === "app2" || /^app\d+$/i.test(k)) metaAppKey = k;
  }
  // state = nanoid.port.metaAppKey.appId  (appId = Meta App ID, unique per customer)
  if (parts.length >= 4 && /^\d{5,30}$/.test(parts[3])) {
    appId = parts[3];
  } else {
    for (const p of parts) {
      if (/^\d{5,30}$/.test(p)) {
        appId = p;
        break;
      }
    }
  }
  return { port, metaAppKey, appId };
}

function graphVersion() {
  return process.env.FB_GRAPH_VERSION || "v21.0";
}

/**
 * Multi Meta App:
 *   .env: FB_APP_ID / FB_APP_SECRET, FB_APP_ID_N / FB_APP_SECRET_N
 *   data/apps.json: apps added via admin API (secrets stay on server only)
 * Clients auto-sync PUBLIC app list (no secrets) from /client-config.
 */
const dataDir = path.join(__dirname, "data");
const appsFile = path.join(dataDir, "apps.json");
const adminToken = String(process.env.RELAY_ADMIN_TOKEN || "").trim();
/** 1 = khách chỉ cần gửi ID+Secret (không cần token) — dùng server nhà / mạng tin cậy */
const allowOpenRegister =
  String(process.env.RELAY_ALLOW_OPEN_REGISTER || "").trim() === "1" ||
  String(process.env.RELAY_ALLOW_OPEN_REGISTER || "").toLowerCase() === "true";

function readAppsFile() {
  try {
    if (!fs.existsSync(appsFile)) return [];
    const j = JSON.parse(fs.readFileSync(appsFile, "utf8"));
    const list = Array.isArray(j) ? j : j.apps || [];
    return list
      .map((a) => ({
        key: String(a.key || "").trim(),
        name: String(a.name || a.key || "").trim(),
        appId: String(a.appId || a.app_id || "").trim(),
        appSecret: String(a.appSecret || a.app_secret || "").trim(),
      }))
      .filter((a) => a.key && a.appId);
  } catch {
    return [];
  }
}

function writeAppsFile(list) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    appsFile,
    JSON.stringify({ apps: list, updated_at: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

/** Resolve server .env path (same search order as startup load). */
function serverEnvPath() {
  for (const p of [
    path.join(__dirname, ".env"),
    path.join(__dirname, "..", ".env"),
    path.join(__dirname, "..", "oauth-relay.env"),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return path.join(__dirname, ".env");
}

/**
 * Upsert KEY=value in server .env and process.env so new apps work without restart.
 * Used when client pushes App ID + Secret.
 */
function writeServerEnvValues(values) {
  const envPath = serverEnvPath();
  let text = "";
  try {
    if (fs.existsSync(envPath)) text = fs.readFileSync(envPath, "utf8");
  } catch {
    text = "";
  }
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  for (const [key, value] of Object.entries(values)) {
    const safe = String(value ?? "");
    if (/[\r\n]/.test(safe)) continue;
    process.env[key] = safe;
    const pattern = new RegExp(`^(\\s*${key}\\s*=).*?$`, "m");
    if (pattern.test(text)) {
      text = text.replace(pattern, (_m, prefix) => `${prefix}${safe}`);
    } else {
      text += `${text && !text.endsWith("\n") && !text.endsWith("\r\n") ? newline : ""}${key}=${safe}${newline}`;
    }
  }
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, text, "utf8");
  return envPath;
}

/** Map app1 → FB_APP_ID, app2 → FB_APP_ID_2, … */
function envKeysForApp(metaAppKey) {
  const m = /^app(\d+)$/i.exec(String(metaAppKey || "app1"));
  const n = m ? Number(m[1]) : 1;
  if (n <= 1) {
    return {
      id: "FB_APP_ID",
      secret: "FB_APP_SECRET",
      name: "FB_APP_NAME",
    };
  }
  return {
    id: `FB_APP_ID_${n}`,
    secret: `FB_APP_SECRET_${n}`,
    name: `FB_APP_NAME_${n}`,
  };
}

function envAppCreds(metaAppKey) {
  const key = String(metaAppKey || "app1").trim() || "app1";
  const m = /^app(\d+)$/i.exec(key);
  const n = m ? Number(m[1]) : 1;
  if (n <= 1) {
    return {
      appId: String(process.env.FB_APP_ID || process.env.FB_APP_ID_1 || "").trim(),
      appSecret: String(process.env.FB_APP_SECRET || process.env.FB_APP_SECRET_1 || "").trim(),
      name: process.env.FB_APP_NAME || process.env.FB_APP_NAME_1 || "App 1",
    };
  }
  return {
    appId: String(process.env[`FB_APP_ID_${n}`] || "").trim(),
    appSecret: String(process.env[`FB_APP_SECRET_${n}`] || "").trim(),
    name: process.env[`FB_APP_NAME_${n}`] || `App ${n}`,
  };
}

/** All known apps on server (env + json) with secrets — for lookup by Meta App ID. */
function allServerAppsWithSecrets() {
  const byId = new Map();
  const add = (key, appId, appSecret, name) => {
    const id = String(appId || "").trim();
    const secret = String(appSecret || "").trim();
    if (!id) return;
    byId.set(id, {
      key: key || `app_id_${id}`,
      appId: id,
      appSecret: secret,
      name: name || key || id,
    });
  };
  const e1 = envAppCreds("app1");
  if (e1.appId) add("app1", e1.appId, e1.appSecret, e1.name);
  for (let n = 2; n <= 40; n++) {
    const e = envAppCreds(`app${n}`);
    if (e.appId) add(`app${n}`, e.appId, e.appSecret, e.name);
  }
  for (const a of readAppsFile()) {
    // file can fill secret if env only has id, or full entry
    const prev = byId.get(a.appId);
    if (!prev) add(a.key, a.appId, a.appSecret, a.name);
    else if (!prev.appSecret && a.appSecret) {
      prev.appSecret = a.appSecret;
      if (a.name) prev.name = a.name;
    }
  }
  return byId;
}

function appCreds(metaAppKey, appIdHint = "") {
  const hint = String(appIdHint || "").trim();
  // Prefer lookup by Meta App ID — each customer machine has local "App 1/App 2"
  // but server stores many real apps; must not use wrong secret via slot name alone.
  if (hint) {
    const hit = allServerAppsWithSecrets().get(hint);
    if (hit?.appId && hit?.appSecret) return hit;
  }
  const key = String(metaAppKey || "app1").trim() || "app1";
  const fromEnv = envAppCreds(key);
  if (fromEnv.appId && fromEnv.appSecret) return fromEnv;
  const fromFile = readAppsFile().find((a) => a.key === key);
  if (fromFile?.appId && fromFile?.appSecret) {
    return { appId: fromFile.appId, appSecret: fromFile.appSecret, name: fromFile.name, key };
  }
  if (fromEnv.appId && fromFile?.appSecret) {
    return {
      appId: fromEnv.appId,
      appSecret: fromFile.appSecret,
      name: fromFile.name || fromEnv.name,
      key,
    };
  }
  return { ...fromEnv, key };
}

/** Public list for EXE auto-sync — full app_id, no secrets. */
function listRelayAppsPublic() {
  const byKey = new Map();
  const add = (key, appId, name) => {
    const id = String(appId || "").trim();
    const k = String(key || "").trim();
    if (!k || !id) return;
    byKey.set(k, {
      key: k,
      name: name || k,
      app_id: id,
      redirect_uri: redirectUri(),
      configured: true,
    });
  };
  const e1 = envAppCreds("app1");
  if (e1.appId) add("app1", e1.appId, e1.name);
  for (let n = 2; n <= 20; n++) {
    const e = envAppCreds(`app${n}`);
    if (e.appId) add(`app${n}`, e.appId, e.name);
  }
  for (const a of readAppsFile()) {
    if (!byKey.has(a.key)) add(a.key, a.appId, a.name);
  }
  return [...byKey.values()].sort((a, b) =>
    a.key.localeCompare(b.key, undefined, { numeric: true })
  );
}

function nextAppKey() {
  const used = new Set(listRelayAppsPublic().map((a) => a.key));
  for (let n = 1; n <= 50; n++) {
    const k = `app${n}`;
    if (!used.has(k)) return k;
  }
  return `app${Date.now()}`;
}

function requireAdmin(req) {
  // Server nhà: cho phép khách đẩy App ID+Secret không token (tự ghi .env)
  if (allowOpenRegister) return { ok: true, open: true };
  if (!adminToken) {
    return {
      ok: false,
      error:
        "Server chặn đăng ký app. Đặt RELAY_ALLOW_OPEN_REGISTER=1 (server nhà) " +
        "hoặc RELAY_ADMIN_TOKEN=... và gửi token từ tool.",
    };
  }
  const h = String(req.headers["x-relay-admin-token"] || req.headers["authorization"] || "").trim();
  const token = h.replace(/^Bearer\s+/i, "");
  if (token !== adminToken) return { ok: false, error: "Sai RELAY_ADMIN_TOKEN" };
  return { ok: true };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function redirectUri() {
  const fromEnv = String(process.env.FB_REDIRECT_URI || "").trim();
  if (fromEnv) return fromEnv;
  const base = String(publicName).replace(/\/$/, "");
  return `${base}/auth/facebook/callback`;
}

async function exchangeCode(code, metaAppKey, appIdHint = "") {
  const { appId, appSecret } = appCreds(metaAppKey, appIdHint);
  if (!appId || !appSecret) {
    throw new Error(
      `Relay thiếu secret cho app ${metaAppKey}` +
        (appIdHint ? ` (Meta ID ${appIdHint})` : "") +
        " — khách cần đẩy App ID+Secret lên server trước."
    );
  }
  const uri = redirectUri();
  const url = new URL(`https://graph.facebook.com/${graphVersion()}/oauth/access_token`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("redirect_uri", uri);
  url.searchParams.set("code", code);
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) {
    throw new Error(data.error.message || "Graph exchange failed");
  }
  let access = data.access_token;
  let expiresIn = data.expires_in;
  // long-lived
  try {
    const longUrl = new URL(`https://graph.facebook.com/${graphVersion()}/oauth/access_token`);
    longUrl.searchParams.set("grant_type", "fb_exchange_token");
    longUrl.searchParams.set("client_id", appId);
    longUrl.searchParams.set("client_secret", appSecret);
    longUrl.searchParams.set("fb_exchange_token", access);
    const lr = await fetch(longUrl);
    const ld = await lr.json();
    if (ld.access_token) {
      access = ld.access_token;
      expiresIn = ld.expires_in || expiresIn;
    }
  } catch {
    /* keep short */
  }
  return { access_token: access, expires_in: expiresIn, app_id: appId };
}

function putTicket(payload) {
  const ticket = crypto.randomBytes(24).toString("hex");
  tickets.set(ticket, { ...payload, exp: Date.now() + TICKET_TTL_MS });
  // GC
  for (const [k, v] of tickets) {
    if (v.exp < Date.now()) tickets.delete(k);
  }
  return ticket;
}

function htmlPage(title, body) {
  return `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>
body{font-family:system-ui,Segoe UI,sans-serif;background:#0f1115;color:#e8eaed;max-width:520px;margin:2.5rem auto;padding:0 1rem;line-height:1.55}
code{background:#1e2330;padding:.15rem .4rem;border-radius:4px;word-break:break-all}
.ok{color:#6ee7b7}.warn{color:#fbbf24}
</style></head><body>${body}</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  // Public config for EXE clients (no secrets). EXE may sync FB_REDIRECT_URI from here.
  if (
    url.pathname === "/health" ||
    url.pathname === "/api/health" ||
    url.pathname === "/client-config" ||
    url.pathname === "/api/client-config"
  ) {
    const publicUrl = String(publicName).replace(/\/$/, "");
    const redir = redirectUri();
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(
      JSON.stringify({
        ok: true,
        service: "fb-page-studio-oauth-relay",
        exchange: exchangeMode,
        public_url: /^https?:\/\//i.test(publicUrl) ? publicUrl : `https://${publicUrl}`,
        redirect_uri: redir,
        oauth_relay: true,
        apps: listRelayAppsPublic(),
      })
    );
    return;
  }

  if (url.pathname === "/api/claim") {
    const ticket = url.searchParams.get("ticket") || "";
    const row = tickets.get(ticket);
    if (!row || row.exp < Date.now()) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "Ticket hết hạn hoặc không tồn tại" }));
      return;
    }
    tickets.delete(ticket); // one-time
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        access_token: row.access_token,
        expires_in: row.expires_in,
        meta_app_key: row.meta_app_key,
        app_id: row.app_id,
      })
    );
    return;
  }

  // List apps (public ids) — same as health.apps
  if (url.pathname === "/api/apps" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({ ok: true, apps: listRelayAppsPublic(), redirect_uri: redirectUri() }));
    return;
  }

  // Admin: add/update Meta App on server (secret stays on relay; clients auto-sync public ids)
  // POST /api/admin/apps  Header: X-Relay-Admin-Token: <RELAY_ADMIN_TOKEN>
  // Body: { app_id, app_secret, name?, key? }
  if (url.pathname === "/api/admin/apps" && req.method === "POST") {
    try {
      const auth = requireAdmin(req);
      if (!auth.ok) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: auth.error }));
        return;
      }
      const body = await readJsonBody(req);
      const appId = String(body.app_id || body.appId || "").trim();
      const appSecret = String(body.app_secret || body.appSecret || "").trim();
      const name = String(body.name || "").trim() || `App ${appId.slice(-4)}`;
      let key = String(body.key || "").trim();
      if (!/^\d{5,30}$/.test(appId)) throw new Error("app_id phải là App ID Meta (số)");
      if (appSecret.length < 16) throw new Error("app_secret bắt buộc (tối thiểu 16 ký tự) — chỉ lưu trên server");
      // Theo Meta App ID: cùng ID = cập nhật secret; ID mới = slot server mới.
      // Tên "App 1/App 2" trên máy khách chỉ là slot local — không đè app của máy khác.
      const existingById = listRelayAppsPublic().find((a) => a.app_id === appId);
      if (existingById) {
        key = existingById.key;
      } else {
        key = nextAppKey();
      }
      if (!/^app\d+$/i.test(key)) throw new Error("key phải dạng app1, app2, app3…");

      // 1) Backup JSON
      const list = readAppsFile().filter((a) => a.key !== key && a.appId !== appId);
      list.push({ key, name, appId, appSecret });
      writeAppsFile(list);

      // 2) Ghi thẳng vào .env server (đúng ý: ID + secret tự vào env sever)
      const ek = envKeysForApp(key);
      const envPath = writeServerEnvValues({
        [ek.id]: appId,
        [ek.secret]: appSecret,
        [ek.name]: name,
        // giữ redirect chuẩn nếu chưa có
        FB_REDIRECT_URI:
          String(process.env.FB_REDIRECT_URI || "").trim() ||
          `${String(publicName).replace(/\/$/, "")}/auth/facebook/callback`,
      });

      console.log(`[relay-admin] upsert app ${key} id=${appId} → .env ${envPath}`);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          key,
          name,
          app_id: appId,
          env_path: envPath,
          env_keys: [ek.id, ek.secret, ek.name],
          message:
            `Đã ghi ${ek.id} + ${ek.secret} vào .env server. ` +
            "Máy khách mở lại tool sẽ tự đồng bộ App ID (không nhận secret).",
          apps: listRelayAppsPublic(),
        })
      );
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
    return;
  }

  if (url.pathname === "/api/admin/apps" && req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Relay-Admin-Token, Authorization",
    });
    res.end();
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      htmlPage(
        "OAuth Relay",
        `<h1>FB Page Studio — OAuth Relay</h1>
<p class="ok">Mode: <b>${exchangeMode ? "EXCHANGE (secret trên relay)" : "REDIRECT (code về EXE)"}</b></p>
<p>Public: <code>${publicName}</code></p>
<p>Callback: <code>/auth/facebook/callback</code></p>
<p class="warn">Giữ EXE đang mở trên máy Connect. Không Ngrok máy khách.</p>`
      )
    );
    return;
  }

  if (
    url.pathname === "/auth/facebook/callback" ||
    url.pathname === "/auth/facebook/callback/" ||
    (url.pathname === "/" && url.searchParams.has("code"))
  ) {
    try {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state") || "";
      const err = url.searchParams.get("error");
      const { port, metaAppKey, appId: stateAppId } = parseState(state);

      if (err) {
        const target = new URL(`http://127.0.0.1:${port}/auth/facebook/callback`);
        for (const [k, v] of url.searchParams) target.searchParams.set(k, v);
        res.writeHead(302, { Location: target.toString(), "Cache-Control": "no-store" });
        res.end();
        return;
      }

      if (exchangeMode && code) {
        const tok = await exchangeCode(code, metaAppKey, stateAppId);
        const ticket = putTicket({
          access_token: tok.access_token,
          expires_in: tok.expires_in,
          meta_app_key: metaAppKey,
          app_id: tok.app_id,
        });
        const target = `http://127.0.0.1:${port}/auth/facebook/relay-complete?ticket=${encodeURIComponent(ticket)}`;
        res.writeHead(302, { Location: target, "Cache-Control": "no-store" });
        res.end();
        console.log(
          `[relay-exchange] ticket → 127.0.0.1:${port} slot=${metaAppKey} metaId=${stateAppId || tok.app_id}`
        );
        return;
      }

      // REDIRECT mode — forward code to local EXE (needs secret on EXE)
      const target = new URL(`http://127.0.0.1:${port}/auth/facebook/callback`);
      for (const [k, v] of url.searchParams) target.searchParams.set(k, v);
      res.writeHead(302, { Location: target.toString(), "Cache-Control": "no-store" });
      res.end();
      console.log(`[relay-redirect] → 127.0.0.1:${port}`);
    } catch (e) {
      console.error("[relay]", e);
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(htmlPage("Relay lỗi", `<p>${String(e.message || e)}</p>`));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("OAuth Relay — not found");
});

server.listen(listenPort, listenHost, () => {
  console.log(`\n  OAuth Relay  ${listenHost}:${listenPort}`);
  console.log(`  Mode         ${exchangeMode ? "EXCHANGE (customer-safe)" : "REDIRECT (internal)"}`);
  console.log(`  Public       ${publicName}`);
  console.log(`  Redirect URI ${redirectUri()}\n`);
});
