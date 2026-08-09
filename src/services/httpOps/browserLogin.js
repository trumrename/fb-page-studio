/**
 * Browser login via Playwright (optional dependency).
 * Default: headed Chromium + persistent profile → ít checkpoint hơn headless.
 *
 * Install once:
 *   npm i playwright
 *   npx playwright install chromium
 */
import { classifyLoginPage } from "./loginErrors.js";

async function loadPlaywright() {
  try {
    const pw = await import("playwright");
    return pw.chromium;
  } catch (e) {
    const err = new Error(
      "BROWSER_NOT_AVAILABLE: npm i playwright && npx playwright install chromium"
    );
    err.cause = e;
    throw err;
  }
}

function cookiesToHeader(cookies) {
  return (cookies || [])
    .filter((c) => /facebook\.com|fb\.com/i.test(c.domain || ""))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

function extractCUser(cookieHeader) {
  const m = String(cookieHeader).match(/(?:^|;\s*)c_user=(\d+)/);
  return m?.[1] || null;
}

/**
 * @param {{
 *   loginId: string,
 *   password: string,
 *   totpCode?: string|null,
 *   userDataDir: string,
 *   proxyUrl?: string,
 *   headless?: boolean,
 *   timeoutMs?: number
 * }} opts
 */
export async function loginWithBrowser(opts) {
  const chromium = await loadPlaywright();
  const timeout = opts.timeoutMs || 120000;
  const launchOpts = {
    headless: opts.headless === true,
    viewport: { width: 1280, height: 800 },
    args: ["--disable-blink-features=AutomationControlled"],
  };
  if (opts.proxyUrl) {
    try {
      const u = new URL(opts.proxyUrl);
      launchOpts.proxy = {
        server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`,
        username: u.username || undefined,
        password: u.password || undefined,
      };
    } catch {
      /* ignore bad proxy url */
    }
  }

  const context = await chromium.launchPersistentContext(opts.userDataDir, launchOpts);
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(Math.min(timeout, 60000));

  try {
    await page.goto("https://www.facebook.com/login", {
      waitUntil: "domcontentloaded",
      timeout,
    });

    // Already logged in?
    await page.waitForTimeout(1500);
    let url = page.url();
    let html = "";
    try {
      html = await page.content();
    } catch {
      /* */
    }
    let cls = classifyLoginPage(url, html);
    if (cls === "OK" || (/facebook\.com/i.test(url) && !/login|checkpoint/i.test(url))) {
      const cookies = await context.cookies();
      const cookieHeader = cookiesToHeader(cookies);
      if (cookieHeader.includes("c_user=")) {
        await context.close();
        return {
          ok: true,
          cookieHeader,
          fbUserId: extractCUser(cookieHeader),
          code: "OK",
        };
      }
    }

    // Fill login
    const emailSel = 'input[name="email"], #email';
    const passSel = 'input[name="pass"], #pass';
    await page.waitForSelector(emailSel, { timeout: 20000 });
    await page.fill(emailSel, opts.loginId);
    await page.fill(passSel, opts.password);
    await Promise.all([
      page.click('button[name="login"], #loginbutton, button[type="submit"]').catch(() =>
        page.keyboard.press("Enter")
      ),
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => null),
    ]);
    await page.waitForTimeout(2000);

    url = page.url();
    html = await page.content().catch(() => "");
    cls = classifyLoginPage(url, html);

    // 2FA authenticator
    if (cls === "NEED_2FA" || /two_step|approvals|checkpoint/i.test(url)) {
      const codeInputs = await page.$$(
        'input[name="approvals_code"], input#approvals_code, input[autocomplete="one-time-code"]'
      );
      if (codeInputs.length && opts.totpCode) {
        await codeInputs[0].fill(opts.totpCode);
        await page.click('button[type="submit"], #checkpointSubmitButton, button[name="submit"]').catch(
          () => page.keyboard.press("Enter")
        );
        await page.waitForTimeout(2500);
        url = page.url();
        html = await page.content().catch(() => "");
        cls = classifyLoginPage(url, html);
      } else if (!opts.totpCode) {
        await context.close();
        return {
          ok: false,
          code: "NEED_2FA",
          detail: "Cần secret 2FA (id|pass|2fa)",
        };
      }
    }

    // Save browser / continue buttons common on FB
    for (let i = 0; i < 3; i++) {
      const cont = page.locator(
        'button:has-text("Continue"), button:has-text("Tiếp"), button:has-text("This was me"), button:has-text("Trust"), #checkpointSubmitButton'
      );
      if (await cont.count().catch(() => 0)) {
        await cont.first().click().catch(() => null);
        await page.waitForTimeout(1500);
      }
    }

    url = page.url();
    html = await page.content().catch(() => "");
    cls = classifyLoginPage(url, html);

    if (cls === "CHECKPOINT_282" || /282|code from your email|mã xác nhận|nhập mã/i.test(html + url)) {
      // Try click "send code to email" if present
      const send = page.locator(
        'text=/email|mail|hộp thư|Send code|Gửi mã/i'
      );
      if (await send.count().catch(() => 0)) {
        await send.first().click().catch(() => null);
        await page.waitForTimeout(1500);
      }
      // Keep context profile on disk — do NOT close fully so submit can reuse
      // Playwright persistent context must close; profile dir keeps state.
      await context.close();
      return {
        ok: false,
        code: "CHECKPOINT_282_CODE_SENT",
        detail: "Facebook yêu cầu mã email (282). Dán mã qua API submit-282-code.",
      };
    }

    if (cls === "WRONG_PASSWORD") {
      await context.close();
      return { ok: false, code: "WRONG_PASSWORD", detail: url };
    }
    if (cls === "CAPTCHA") {
      await context.close();
      return { ok: false, code: "CAPTCHA", detail: url };
    }
    if (cls === "DISABLED_ACCOUNT") {
      await context.close();
      return { ok: false, code: "DISABLED_ACCOUNT", detail: url };
    }
    if (cls === "CHECKPOINT_OTHER") {
      await context.close();
      return { ok: false, code: "CHECKPOINT_OTHER", detail: url };
    }

    const cookies = await context.cookies();
    const cookieHeader = cookiesToHeader(cookies);
    await context.close();

    if (cookieHeader.includes("c_user=") && cookieHeader.includes("xs=")) {
      return {
        ok: true,
        cookieHeader,
        fbUserId: extractCUser(cookieHeader),
        code: "OK",
      };
    }

    return {
      ok: false,
      code: cls || "UNKNOWN",
      detail: `url=${url} cookie_has_c_user=${cookieHeader.includes("c_user=")}`,
    };
  } catch (e) {
    try {
      await context.close();
    } catch {
      /* */
    }
    const msg = e?.message || String(e);
    if (/timeout/i.test(msg)) {
      return { ok: false, code: "BROWSER_TIMEOUT", detail: msg };
    }
    return { ok: false, code: "UNKNOWN", detail: msg };
  }
}

/**
 * Resume profile and enter email 282 code.
 */
export async function submitEmailCode(opts) {
  const chromium = await loadPlaywright();
  const timeout = opts.timeoutMs || 90000;
  const launchOpts = {
    headless: opts.headless === true,
    viewport: { width: 1280, height: 800 },
  };
  if (opts.proxyUrl) {
    try {
      const u = new URL(opts.proxyUrl);
      launchOpts.proxy = {
        server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`,
        username: u.username || undefined,
        password: u.password || undefined,
      };
    } catch {
      /* */
    }
  }

  const context = await chromium.launchPersistentContext(opts.userDataDir, launchOpts);
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(Math.min(timeout, 60000));

  try {
    // If not on checkpoint, go home / checkpoint
    const url0 = page.url();
    if (!/facebook\.com/i.test(url0)) {
      await page.goto("https://www.facebook.com/", {
        waitUntil: "domcontentloaded",
        timeout,
      });
    }
    await page.waitForTimeout(1000);

    const input = page.locator(
      'input[name="approvals_code"], input#approvals_code, input[name="code"], input[autocomplete="one-time-code"], input[type="text"]'
    );
    if (!(await input.count())) {
      await page.goto("https://www.facebook.com/checkpoint/", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      }).catch(() => null);
    }

    const filled = await input
      .first()
      .fill(opts.code)
      .then(() => true)
      .catch(() => false);
    if (!filled) {
      await context.close();
      return {
        ok: false,
        code: "CHECKPOINT_282_BAD_CODE",
        detail: "Không tìm thấy ô nhập mã trên trang",
      };
    }

    await page.click('button[type="submit"], #checkpointSubmitButton, button[name="submit"]').catch(
      () => page.keyboard.press("Enter")
    );
    await page.waitForTimeout(3000);

    // Continue buttons
    for (let i = 0; i < 3; i++) {
      const cont = page.locator(
        'button:has-text("Continue"), button:has-text("Tiếp"), #checkpointSubmitButton'
      );
      if (await cont.count().catch(() => 0)) {
        await cont.first().click().catch(() => null);
        await page.waitForTimeout(1200);
      }
    }

    const url = page.url();
    const html = await page.content().catch(() => "");
    const cls = classifyLoginPage(url, html);
    const cookies = await context.cookies();
    const cookieHeader = cookiesToHeader(cookies);
    await context.close();

    if (cookieHeader.includes("c_user=") && cookieHeader.includes("xs=") && cls !== "CHECKPOINT_282") {
      return {
        ok: true,
        cookieHeader,
        fbUserId: extractCUser(cookieHeader),
        code: "OK",
      };
    }

    return {
      ok: false,
      code: cls === "OK" ? "CHECKPOINT_282_BAD_CODE" : cls || "CHECKPOINT_282_BAD_CODE",
      detail: url,
    };
  } catch (e) {
    try {
      await context.close();
    } catch {
      /* */
    }
    return { ok: false, code: "UNKNOWN", detail: e.message };
  }
}
