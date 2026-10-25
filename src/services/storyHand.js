/**
 * Story bằng tay: mở Business Suite story composer, chọn file, gắn link, đăng.
 * Không gọi API story (không có tham số link).
 */
import fs from "fs";
import os from "os";
import path from "path";

const state = {
  running: false,
  logs: [],
  stop: false,
  context: null,
};

function push(line) {
  state.logs.push(`${new Date().toLocaleTimeString("vi-VN")} ${line}`);
  if (state.logs.length > 400) state.logs.shift();
}

export function storyHandStatus() {
  return { running: state.running, logs: state.logs.slice(-120) };
}

export function storyViaDir() {
  const dir = path.join(os.homedir(), "AppData", "Roaming", "fb-page-studio", "story-via");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function stopStoryHand() {
  state.stop = true;
  push("Đã nhận lệnh dừng");
  return { ok: true };
}

function pageIdsFromText(text) {
  const seen = new Set();
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const nums = trimmed.match(/\d{6,}/g);
    const id = nums ? nums[nums.length - 1] : "";
    if (!/^\d{5,}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

async function clickByText(page, source) {
  return page.evaluate((pattern) => {
    const rx = new RegExp(pattern, "i");
    const nodes = Array.from(document.querySelectorAll("button, [role='button'], [role='menuitem']"));
    const hits = nodes.filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const text = (el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      return rx.test(text);
    });
    hits.sort((a, b) => (a.innerText || "").length - (b.innerText || "").length);
    if (!hits[0]) return false;
    hits[0].click();
    return (hits[0].innerText || hits[0].getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
  }, source);
}

async function mediaVisible(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 40 && r.height > 40;
    };
    if (Array.from(document.querySelectorAll("video")).some((v) => vis(v) && (v.videoWidth > 0 || v.readyState >= 2))) return true;
    return Array.from(document.querySelectorAll("img")).some((im) => {
      const src = im.currentSrc || im.src || "";
      return vis(im) && im.naturalWidth > 80 && /blob:|fbcdn|scontent/i.test(src);
    });
  });
}

async function fillLink(page, link) {
  return page.evaluate((value) => {
    const inputs = Array.from(document.querySelectorAll("input, textarea"));
    const hit = inputs.find((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const blob = `${el.type || ""} ${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""}`;
      return el.type === "url" || /url|http|link|liên kết|website|dán/i.test(blob);
    });
    if (!hit) return false;
    const proto = hit.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(hit, value);
    else hit.value = value;
    hit.dispatchEvent(new Event("input", { bubbles: true }));
    hit.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, link);
}

export function startStoryHand(opts) {
  if (state.running) return { ok: false, error: "Đang chạy story khác" };
  const pageIds = pageIdsFromText(opts.pageIdsText || "");
  const filePath = String(opts.filePath || "").trim();
  const link = String(opts.link || "").trim();
  const mode = opts.mode === "schedule" ? "schedule" : "now";
  if (!pageIds.length) return { ok: false, error: "Dán Page ID, mỗi dòng một ID" };
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: "Chưa có file ảnh/video trên ổ" };
  if (!/^https?:\/\/\S+$/i.test(link)) return { ok: false, error: "Link phải là http:// hoặc https://" };
  state.running = true;
  state.stop = false;
  state.logs = [];
  push(`Bắt đầu ${pageIds.length} page · ${path.basename(filePath)}`);
  runStoryHand({ pageIds, filePath, link, mode, scheduleLocal: opts.scheduleLocal || "" }).catch((e) => {
    push("Lỗi: " + (e?.message || e));
  }).finally(() => {
    state.running = false;
  });
  return { ok: true, started: true, count: pageIds.length };
}

async function runStoryHand({ pageIds, filePath, link, mode, scheduleLocal }) {
  let chromium;
  try {
    const pw = await import("playwright");
    chromium = pw.chromium;
  } catch {
    push("Chưa có Playwright. Trong F:\\fb-page-poster chạy: npm i playwright && npx playwright install chromium");
    return;
  }
  let context = state.context;
  if (!context) {
    context = await chromium.launchPersistentContext(storyViaDir(), {
      headless: false,
      viewport: { width: 1400, height: 900 },
      args: ["--disable-blink-features=AutomationControlled"],
    });
    state.context = context;
  }
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(20000);
  try {
    for (let i = 0; i < pageIds.length; i++) {
      if (state.stop) {
        push("Dừng");
        break;
      }
      const pageId = pageIds[i];
      const url = `https://business.facebook.com/latest/story_composer?page_id=${pageId}&asset_id=${pageId}`;
      push(`${i + 1}/${pageIds.length} mở ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2500);
      if (/login|checkpoint/i.test(page.url())) {
        push("Via chưa đăng nhập. Đăng nhập trên cửa sổ vừa mở, rồi bấm Chạy lại.");
        return;
      }
      const input = page.locator("input[type='file']").first();
      await input.waitFor({ state: "attached", timeout: 30000 });
      await input.setInputFiles(filePath);
      push("Đã chọn file, đợi media hiện");
      const deadline = Date.now() + (/\.(mp4|mov|m4v|webm)$/i.test(filePath) ? 180000 : 70000);
      let loaded = false;
      while (Date.now() < deadline) {
        if (state.stop) break;
        if (await mediaVisible(page)) {
          loaded = true;
          break;
        }
        await page.waitForTimeout(500);
      }
      if (!loaded) {
        push(`LỖI ${pageId} — media chưa hiện trên composer`);
        continue;
      }
      push("Media đã lên, tìm chỗ gắn link");
      const opened = await clickByText(page, "thêm liên kết|add a link|add link|link sticker|^link$|^liên kết$");
      if (!opened) {
        push(`LỖI ${pageId} — không thấy nút gắn link`);
        continue;
      }
      await page.waitForTimeout(800);
      const filled = await fillLink(page, link);
      if (!filled) {
        push(`LỖI ${pageId} — không thấy ô dán link`);
        continue;
      }
      push("Đã dán link");
      await page.waitForTimeout(600);
      const applied = await clickByText(page, "^(áp dụng|apply|xong|done)$");
      if (!applied) {
        push(`LỖI ${pageId} — không thấy nút Áp dụng`);
        continue;
      }
      await page.waitForTimeout(800);
      if (mode === "schedule") {
        const sched = await clickByText(page, "^(lên lịch|hẹn giờ|schedule)$");
        if (!sched) {
          push(`LỖI ${pageId} — không thấy nút hẹn giờ. Link đã gắn, chưa đăng.`);
          continue;
        }
        if (scheduleLocal) {
          const [datePart, timePart] = String(scheduleLocal).split("T");
          const dateInput = page.locator("input[type='date']").first();
          const timeInput = page.locator("input[type='time']").first();
          if (await dateInput.count()) await dateInput.fill(datePart || "");
          if (await timeInput.count()) await timeInput.fill((timePart || "").slice(0, 5));
        }
        await clickByText(page, "^(lên lịch|schedule|xác nhận|confirm)$");
        push(`OK hẹn ${pageId}`);
      } else {
        const shared = await clickByText(page, "chia sẻ ngay|đăng ngay|share now|^(chia sẻ|share|đăng)$");
        if (!shared) {
          push(`LỖI ${pageId} — không thấy nút đăng. Link đã gắn.`);
          continue;
        }
        push(`OK đăng ${pageId}`);
      }
      await page.waitForTimeout(3500);
    }
  } finally {
    let keepOpen = false;
    try {
      keepOpen = /login|checkpoint/i.test(page.url() || "");
    } catch {
      keepOpen = false;
    }
    if (!keepOpen) {
      state.context = null;
      await context.close().catch(() => {});
    }
  }
}
