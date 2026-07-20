import { Router } from "express";
import { nanoid } from "nanoid";
import { getDb, cleanupOldOauthStates } from "../db/index.js";
import { buildLoginUrl } from "../services/facebook.js";
import {
  connectFromOAuthCode,
  connectFromUserToken,
} from "../services/accounts.js";
import { config } from "../config.js";
import {
  assertMetaAppConfigured,
  getMetaApp,
  listMetaAppsPublic,
} from "../services/metaApps.js";
import { isOauthRelayMode } from "../services/deployMode.js";

const router = Router();

function createOAuthSession(metaAppKey = "app1", rerequest = false) {
  cleanupOldOauthStates();
  const app = assertMetaAppConfigured(metaAppKey);
  // Append local port so OAuth relay can 302 back to this EXE (127.0.0.1:port)
  // Format: <nanoid>.<port> — portable + relay; harmless if no relay.
  // state = nanoid.port.metaAppKey — relay parses port + app; DB stores full state
  const state = `${nanoid(32)}.${config.port}.${app.key}`;
  getDb()
    .prepare(
      `INSERT INTO oauth_states (state, meta_app_key) VALUES (?, ?)`
    )
    .run(state, app.key);
  const url = buildLoginUrl(state, {
    rerequest,
    app: {
      appId: app.appId,
      redirectUri: app.redirectUri,
      scopes: app.scopes,
    },
  });
  return { state, url, app };
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function errorPage(title, detail, tip) {
  return `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title>
<style>
body{font-family:Segoe UI,sans-serif;background:#1a1010;color:#ffc0c7;padding:2rem;line-height:1.55;max-width:560px;margin:0 auto}
code{background:#2a1515;padding:.2rem .4rem;border-radius:4px;word-break:break-all}
a{color:#9ec1ff}
.btn{display:inline-block;margin-top:1rem;background:#1877f2;color:#fff;text-decoration:none;padding:.65rem 1rem;border-radius:8px;font-weight:700}
</style></head>
<body><h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(detail)}</p>
<p><b>Gợi ý:</b> ${escapeHtml(tip)}</p>
<p><a class="btn" href="/auth/facebook?external=1&app=app1">Connect App 1</a>
 · <a class="btn" href="/auth/facebook?external=1&app=app2">Connect App 2</a>
 · <a href="/index.html">Về Pages</a></p></body></html>`;
}

/** GET /auth/apps — list configured Meta Apps (no secrets) */
router.get("/apps", (_req, res) => {
  res.json({ apps: listMetaAppsPublic() });
});

/**
 * GET /auth/facebook
 * Query:
 *  - app=app1|app2  (default app1)
 *  - external=1, json=1, rerequest=1
 */
router.get("/facebook", (req, res) => {
  const metaAppKey = String(req.query.app || req.query.meta_app || "app1");

  let app;
  try {
    app = assertMetaAppConfigured(metaAppKey);
  } catch (e) {
    return res
      .status(500)
      .type("html")
      .send(
        errorPage(
          "Meta App chưa cấu hình",
          e.message,
          metaAppKey === "app2"
            ? "Trong .env thêm FB_APP_ID_2, FB_APP_SECRET_2 (và redirect URI của App 2 trên Meta)."
            : "Đặt .env cạnh app: FB_APP_ID, FB_APP_SECRET, FB_REDIRECT_URI."
        )
      );
  }

  const rerequest =
    req.query.rerequest === "1" || req.query.rerequest === "true";
  const { url } = createOAuthSession(app.key, rerequest);

  if (req.query.json === "1" || req.query.format === "json") {
    return res.json({
      ok: true,
      url,
      meta_app_key: app.key,
      meta_app_name: app.name,
      redirect_uri: app.redirectUri,
      tip: "Mở URL trong Chrome/Edge. Nhập pass + mã 2FA nếu có.",
    });
  }

  if (req.query.external === "1" || req.query.desktop === "1") {
    return res.type("html").send(`<!DOCTYPE html>
<html lang="vi"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Connect ${escapeHtml(app.name)} · 2FA</title>
<style>
body{font-family:Segoe UI,system-ui,sans-serif;background:#0f1115;color:#e8eaed;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{max-width:460px;padding:2rem;border:1px solid #2a2f3a;border-radius:16px;background:#171a21}
h1{font-size:1.2rem;margin:0 0 .75rem;color:#1877f2}
p{line-height:1.55;color:#9aa0a6;font-size:.92rem}
a.btn{display:inline-block;margin-top:1rem;background:#1877f2;color:#fff;text-decoration:none;padding:.75rem 1.25rem;border-radius:10px;font-weight:700}
code{background:#1e2330;padding:.1rem .35rem;border-radius:4px;font-size:.78rem;word-break:break-all}
ol{color:#9aa0a6;line-height:1.6;padding-left:1.2rem}
.badge{display:inline-block;padding:.2rem .5rem;border-radius:6px;background:rgba(24,119,242,.2);color:#9ec1ff;font-size:.8rem;font-weight:700}
</style></head><body>
<div class="card">
  <h1>Đăng nhập Facebook</h1>
  <p><span class="badge">${escapeHtml(app.name)} · ${escapeHtml(app.key)}</span></p>
  <p>Tài khoản này sẽ được gắn vào <b>${escapeHtml(app.name)}</b>. Rotation so-le dùng nhóm theo app.</p>
  <ol>
    <li>Mở bằng <b>Chrome / Edge</b> (không cửa sổ app nhúng)</li>
    <li>Nhập email / mật khẩu</li>
    <li>Nhập <b>mã 2FA</b> nếu nick bật</li>
    <li>Cho phép quyền Page → đợi redirect về app</li>
  </ol>
  <p>Redirect: <code>${escapeHtml(app.redirectUri)}</code></p>
  <p>App ID: <code>${escapeHtml(app.appId)}</code></p>
  <a class="btn" id="go" href="${escapeHtml(url)}">Tiếp tục Facebook →</a>
</div>
<script>setTimeout(function(){ location.href = ${JSON.stringify(url)}; }, 500);</script>
</body></html>`);
  }

  res.redirect(url);
});

/** OAuth callback — after password + 2FA; state remembers which Meta App */
router.get("/facebook/callback", async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      return res.status(400).type("html").send(
        errorPage(
          "Facebook từ chối",
          `${error}: ${error_description || ""}`,
          "Thử lại từ đầu. Với 2FA: nhập đủ mã, không đóng tab giữa chừng. Bỏ scope business_management nếu chưa App Review."
        )
      );
    }
    if (!code || !state) {
      return res.status(400).type("html").send(
        errorPage(
          "OAuth chưa hoàn tất",
          "Thiếu code/state (có thể dừng ở bước 2FA).",
          "Connect lại → làm hết mật khẩu + 2FA → Approve."
        )
      );
    }

    const db = getDb();
    const st = db
      .prepare(`SELECT state, meta_app_key FROM oauth_states WHERE state = ?`)
      .get(state);
    if (!st) {
      return res.status(400).type("html").send(
        errorPage(
          "Phiên hết hạn / state không khớp",
          "App restart giữa Connect, hoặc bấm Connect 2 lần.",
          "Mở lại app → Connect một lần → xong hẳn 2FA."
        )
      );
    }
    db.prepare(`DELETE FROM oauth_states WHERE state = ?`).run(state);

    const metaAppKey = st.meta_app_key || "app1";
    let app;
    try {
      app = assertMetaAppConfigured(metaAppKey);
    } catch (e) {
      return res.status(500).type("html").send(
        errorPage("Meta App không còn cấu hình", e.message, "Kiểm tra .env")
      );
    }

    // Gói khách (không secret): code do relay đổi; local chỉ nhận ticket
    if (isOauthRelayMode() && !app.appSecret) {
      return res.status(400).type("html").send(
        errorPage(
          "Cần OAuth qua relay",
          "Máy này không có App Secret (đúng cho gói khách). Callback phải qua relay → ticket.",
          "Giữ app mở, Connect lại. Relay phải bật RELAY_EXCHANGE=1 và có secret."
        )
      );
    }

    const result = await connectFromOAuthCode(String(code), {
      metaAppKey: app.key,
      app: {
        appId: app.appId,
        appSecret: app.appSecret,
        redirectUri: app.redirectUri,
      },
    });
    return sendConnectedPage(res, result, app);
  } catch (e) {
    console.error("[auth/callback]", e);
    res.status(500).type("html").send(
      errorPage(
        "OAuth thất bại",
        e.message || "unknown",
        "Kiểm tra App Secret (gói nội bộ) hoặc relay ticket (gói khách). Redirect URI khớp Meta."
      )
    );
  }
});

/**
 * GET /auth/facebook/relay-complete?ticket=
 * Gói khách: claim token từ relay (secret chỉ trên server relay).
 */
router.get("/facebook/relay-complete", async (req, res) => {
  try {
    const ticket = String(req.query.ticket || "").trim();
    if (!ticket) {
      return res.status(400).type("html").send(
        errorPage("Thiếu ticket", "Relay không gửi ticket.", "Connect lại từ app.")
      );
    }
    let origin = String(
      process.env.OAUTH_RELAY_URL || process.env.RELAY_PUBLIC_URL || ""
    )
      .trim()
      .replace(/\/$/, "");
    if (!origin) {
      try {
        const u = new URL(config.facebook.redirectUri);
        origin = `${u.protocol}//${u.host}`;
      } catch {
        return res.status(500).type("html").send(
          errorPage(
            "Chưa cấu hình relay URL",
            "Thêm OAUTH_RELAY_URL=https://oauth.domain.com",
            "Hoặc FB_REDIRECT_URI trỏ domain relay."
          )
        );
      }
    }
    const claimUrl = `${origin}/api/claim?ticket=${encodeURIComponent(ticket)}`;
    const cr = await fetch(claimUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    const body = await cr.json().catch(() => ({}));
    if (!cr.ok || !body.access_token) {
      throw new Error(body.error || `Claim ticket thất bại (HTTP ${cr.status})`);
    }
    const metaAppKey = String(body.meta_app_key || "app1");
    let app;
    try {
      app = assertMetaAppConfigured(metaAppKey);
    } catch {
      app = {
        key: metaAppKey,
        name: metaAppKey,
        appId: body.app_id || config.facebook.appId,
        appSecret:
          metaAppKey === "app2"
            ? String(process.env.FB_APP_SECRET_2 || process.env.FB_APP_SECRET || "").trim()
            : String(process.env.FB_APP_SECRET || config.facebook.appSecret || "").trim(),
        redirectUri: config.facebook.redirectUri,
      };
    }
    // Prefer secret on this EXE (internal pack) so Graph appsecret_proof works after claim.
    const appSecret =
      String(app.appSecret || "").trim() ||
      (metaAppKey === "app2"
        ? String(process.env.FB_APP_SECRET_2 || process.env.FB_APP_SECRET || "").trim()
        : String(process.env.FB_APP_SECRET || config.facebook.appSecret || "").trim());
    const result = await connectFromUserToken(body.access_token, {
      metaAppKey,
      app: {
        appId: app.appId || body.app_id,
        appSecret,
        redirectUri: app.redirectUri || config.facebook.redirectUri,
      },
      expires_in: body.expires_in,
      upgradeLongLived: false, // relay already upgraded if possible
    });
    return sendConnectedPage(res, result, app);
  } catch (e) {
    console.error("[auth/relay-complete]", e);
    res.status(500).type("html").send(
      errorPage(
        "Nhận token từ relay thất bại",
        e.message || "unknown",
        "Giữ app mở, Connect lại. Relay online + RELAY_EXCHANGE=1. " +
          "Nếu Meta bật Require App Secret Proof: cần FB_APP_SECRET trên EXE (gói nội bộ) " +
          "hoặc tắt proof trên Meta Developers → App settings → Advanced."
      )
    );
  }
});

function sendConnectedPage(res, result, app) {
  const q = new URLSearchParams({
    connected: "1",
    account: String(result.account.id),
    pages: String(result.pages.length),
    skipped: String(result.sync_summary?.skipped_license || 0),
    app: app.key || "app1",
  });
  const localUi = `http://127.0.0.1:${config.port}/index.html?${q}`;
  res.type("html").send(`<!DOCTYPE html>
<html lang="vi"><head>
<meta charset="utf-8"/><title>Đã kết nối</title>
<style>
body{font-family:Segoe UI,sans-serif;background:#0f1115;color:#e8eaed;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{max-width:480px;padding:2rem;border-radius:16px;border:1px solid #2d5c45;background:#14301f}
h1{color:#8fd9a8;font-size:1.25rem;margin:0 0 .75rem}
p{color:#b8f0d0;line-height:1.5}a{color:#9ec1ff}
.badge{display:inline-block;padding:.15rem .45rem;border-radius:6px;background:rgba(24,119,242,.25);color:#9ec1ff;font-size:.85rem}
</style></head><body>
<div class="card">
  <h1>✓ Đã kết nối Facebook</h1>
  <p><span class="badge">${escapeHtml(app.name)} · ${escapeHtml(app.key)}</span></p>
  <p>Account #${result.account.id} · <b>${result.pages.length}</b> Page đang hoạt động.</p>
  ${result.sync_summary?.skipped_license ? `<p style="color:#f5c96a"><b>${result.sync_summary.skipped_license}</b> Page mới không được thêm do giới hạn license.</p>` : ""}
  <p>Tài khoản đã gắn đúng <b>${escapeHtml(app.name)}</b>.</p>
  <p><a class="btn" href="${localUi}" style="display:inline-block;margin:.5rem .5rem 0 0;padding:.65rem 1rem;background:#1877f2;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">← Quay về Pages trong app</a>
  <a class="btn" href="http://127.0.0.1:${config.port}/app.html" style="display:inline-block;margin:.5rem 0 0;padding:.65rem 1rem;background:#2a2f3a;color:#e8eaed;border-radius:8px;text-decoration:none;font-weight:700">Vận hành</a></p>
</div>
</body></html>`);
}

export default router;
