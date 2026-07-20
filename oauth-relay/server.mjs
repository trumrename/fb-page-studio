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
  if (parts.length >= 2) {
    const maybePort = Number(parts[1]);
    if (Number.isFinite(maybePort) && maybePort >= 1024 && maybePort <= 65535) {
      port = maybePort;
    }
  }
  if (parts.length >= 3) {
    const k = parts[2];
    if (k === "app1" || k === "app2" || /^app\d+$/.test(k)) metaAppKey = k;
  }
  return { port, metaAppKey };
}

function graphVersion() {
  return process.env.FB_GRAPH_VERSION || "v21.0";
}

function appCreds(metaAppKey) {
  if (metaAppKey === "app2") {
    return {
      appId: String(process.env.FB_APP_ID_2 || process.env.FB_APP_ID || "").trim(),
      appSecret: String(process.env.FB_APP_SECRET_2 || process.env.FB_APP_SECRET || "").trim(),
    };
  }
  return {
    appId: String(process.env.FB_APP_ID || "").trim(),
    appSecret: String(process.env.FB_APP_SECRET || "").trim(),
  };
}

function redirectUri() {
  const fromEnv = String(process.env.FB_REDIRECT_URI || "").trim();
  if (fromEnv) return fromEnv;
  const base = String(publicName).replace(/\/$/, "");
  return `${base}/auth/facebook/callback`;
}

async function exchangeCode(code, metaAppKey) {
  const { appId, appSecret } = appCreds(metaAppKey);
  if (!appId || !appSecret) {
    throw new Error("Relay thiếu FB_APP_ID / FB_APP_SECRET (cần khi RELAY_EXCHANGE=1)");
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
      const { port, metaAppKey } = parseState(state);

      if (err) {
        const target = new URL(`http://127.0.0.1:${port}/auth/facebook/callback`);
        for (const [k, v] of url.searchParams) target.searchParams.set(k, v);
        res.writeHead(302, { Location: target.toString(), "Cache-Control": "no-store" });
        res.end();
        return;
      }

      if (exchangeMode && code) {
        const tok = await exchangeCode(code, metaAppKey);
        const ticket = putTicket({
          access_token: tok.access_token,
          expires_in: tok.expires_in,
          meta_app_key: metaAppKey,
          app_id: tok.app_id,
        });
        const target = `http://127.0.0.1:${port}/auth/facebook/relay-complete?ticket=${encodeURIComponent(ticket)}`;
        res.writeHead(302, { Location: target, "Cache-Control": "no-store" });
        res.end();
        console.log(`[relay-exchange] ticket → 127.0.0.1:${port} app=${metaAppKey}`);
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
