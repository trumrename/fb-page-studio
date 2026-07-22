/**
 * GitHub Releases auto-update
 * - Panel rõ ràng: version, % tải, log trạng thái (không chỉ đổi chữ nút nhỏ)
 * - Sidebar "Cập nhật phiên bản" luôn mở được panel (không phụ thuộc topbar button)
 * - Progress poll có session: không kết thúc nhầm khi state idle giữa chừng
 */
(function () {
  const RECHECK_MS = 4 * 60 * 60 * 1000;
  const DISMISS_KEY = "fbps_update_dismiss_v";
  const RELEASES_URL = "https://github.com/trumrename/fb-page-studio/releases/latest";

  let lastCheck = null;
  let busy = false;

  function apiBase() {
    // Prefer live page origin; fall back to 127.0.0.1 (Electron desktop).
    try {
      const o = String(window.location.origin || "").replace(/\/$/, "");
      if (o && o !== "null" && o !== "file://" && !o.startsWith("file:")) {
        // Normalize localhost → 127.0.0.1 (some Windows stacks treat them differently)
        if (/^http:\/\/localhost(?::\d+)?$/i.test(o)) {
          return o.replace(/localhost/i, "127.0.0.1");
        }
        return o;
      }
    } catch {
      /* fall through */
    }
    return "http://127.0.0.1:3847";
  }

  function networkHint(err, kind) {
    const msg = String(err?.message || err || "");
    if (/failed to fetch|networkerror|load failed|network request failed|fetch|ECONNREFUSED|abort/i.test(msg)) {
      if (kind === "github" || /GitHub|github\.com|mirror/i.test(msg)) {
        return (
          "Không kết nối được GitHub (mạng chặn/chậm).\n\n" +
          "1) Tắt VPN lạ, thử 4G/mạng khác\n" +
          "2) DNS: 8.8.8.8 hoặc 1.1.1.1\n" +
          "3) Cài TAY (không cần nút Cập nhật):\n   " +
          RELEASES_URL +
          "\n   → FB-Page-Studio-Setup-v….exe"
        );
      }
      return (
        "Không gọi được server tool (local).\n\n" +
        "1) Đóng hẳn FB Page Studio → mở lại bằng icon/EXE\n" +
        "2) Thanh địa chỉ phải http://127.0.0.1:3847/… (không file://, không domain lạ)\n" +
        "3) Port 3847 đang bận? Tắt bản tool cũ trong Task Manager\n" +
        "4) Vẫn lỗi → cài TAY: " +
        RELEASES_URL
      );
    }
    return msg;
  }

  async function api(path, opts = {}, { retries = 3, kind = "local" } = {}) {
    const url = path.startsWith("http")
      ? path
      : `${apiBase()}${path.startsWith("/") ? path : `/${path}`}`;
    let lastErr = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl
        ? setTimeout(() => {
            try {
              ctrl.abort();
            } catch {
              /* ignore */
            }
          }, opts.timeoutMs || 45000)
        : null;
      try {
        const res = await fetch(url, {
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          signal: ctrl ? ctrl.signal : undefined,
          ...opts,
        });
        if (timer) clearTimeout(timer);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || res.statusText || `HTTP ${res.status}`);
        return data;
      } catch (e) {
        if (timer) clearTimeout(timer);
        lastErr = e;
        // Don't hammer if clearly offline
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 350 * attempt));
        }
      }
    }
    // Classify github errors coming back from API body after success path separately
    throw new Error(networkHint(lastErr, kind));
  }

  function ensureStyles() {
    if (document.getElementById("fbpsUpdateStyles")) return;
    const s = document.createElement("style");
    s.id = "fbpsUpdateStyles";
    s.textContent = `
      #updateBanner { position: sticky; top: 0; z-index: 80; }
      .update-banner-inner {
        display:flex; flex-wrap:wrap; gap:.75rem; align-items:center; justify-content:space-between;
        padding:.65rem 1rem; background: rgba(245,197,66,.12); border-bottom:1px solid rgba(245,197,66,.35);
      }
      #fbpsUpdatePanel {
        position: fixed; inset: 0; z-index: 9999; display:none;
        background: rgba(0,0,0,.55); align-items: center; justify-content: center; padding: 1rem;
      }
      #fbpsUpdatePanel.open { display: flex; }
      #fbpsUpdatePanel .panel {
        width: min(520px, 100%); background: var(--panel, #1a1f2e); color: inherit;
        border: 1px solid var(--border, #333); border-radius: 14px; padding: 1.1rem 1.2rem;
        box-shadow: 0 20px 60px rgba(0,0,0,.45);
      }
      #fbpsUpdatePanel h3 { margin: 0 0 .35rem; font-size: 1.1rem; }
      #fbpsUpdatePanel .muted { opacity: .75; font-size: .85rem; }
      #fbpsUpdatePanel .row { display:flex; flex-wrap:wrap; gap:.5rem; margin-top: .85rem; }
      #fbpsUpdatePanel .bar {
        height: 16px; border-radius: 99px; background: rgba(255,255,255,.08);
        border: 1px solid rgba(255,255,255,.12); overflow: hidden; margin-top: .75rem;
      }
      #fbpsUpdatePanel .bar > i {
        display:block; height:100%; width:0%;
        background: linear-gradient(90deg, #1877f2, #7c5cff);
        transition: width .25s ease;
      }
      #fbpsUpdatePanel .log {
        margin-top: .65rem; min-height: 3.2em; font-size: .86rem; line-height: 1.4;
        white-space: pre-wrap; word-break: break-word;
        padding: .55rem .65rem; border-radius: 10px;
        background: rgba(0,0,0,.25); border: 1px solid rgba(255,255,255,.08);
      }
      #fbpsUpdatePanel .pct {
        font-weight: 800; font-variant-numeric: tabular-nums; font-size: 1.25rem; margin-top: .35rem;
      }
      #fbpsUpdateDock {
        position: fixed; right: 1rem; bottom: 1rem; z-index: 90;
        min-width: 220px; max-width: min(360px, calc(100vw - 2rem));
        padding: .7rem .85rem; border-radius: 12px;
        background: rgba(20,24,36,.96); border: 1px solid rgba(79,140,255,.45);
        box-shadow: 0 10px 40px rgba(0,0,0,.4); display: none;
      }
      #fbpsUpdateDock.show { display: block; }
      #fbpsUpdateDock .bar { height: 10px; border-radius: 99px; background: rgba(255,255,255,.08); overflow: hidden; margin-top: .4rem; }
      #fbpsUpdateDock .bar > i { display:block; height:100%; width:0%; background: linear-gradient(90deg,#1877f2,#7c5cff); }
    `;
    document.head.appendChild(s);
  }

  function ensureBtn() {
    let btn = document.getElementById("btnUpdateApp");
    if (btn) return btn;
    const host =
      document.querySelector(".topbar-actions") ||
      document.querySelector("header .actions") ||
      document.querySelector(".topbar");
    if (!host) {
      // Fallback: floating control if page has no topbar
      btn = document.createElement("button");
      btn.type = "button";
      btn.id = "btnUpdateApp";
      btn.className = "btn-ghost btn-sm";
      btn.textContent = "Cập nhật";
      btn.style.cssText = "position:fixed;top:.75rem;right:.75rem;z-index:85";
      document.body.appendChild(btn);
      return btn;
    }
    btn = document.createElement("button");
    btn.type = "button";
    btn.id = "btnUpdateApp";
    btn.className = "btn-ghost btn-sm";
    btn.textContent = "v…";
    btn.title = "Kiểm tra / cập nhật phiên bản từ GitHub";
    host.appendChild(btn);
    return btn;
  }

  function ensurePanel() {
    let el = document.getElementById("fbpsUpdatePanel");
    if (el) return el;
    el = document.createElement("div");
    el.id = "fbpsUpdatePanel";
    el.innerHTML = `
      <div class="panel" role="dialog" aria-labelledby="fbpsUpdateTitle">
        <h3 id="fbpsUpdateTitle">Cập nhật FB Page Studio</h3>
        <div class="muted" id="fbpsUpdateSub">Đang tải thông tin phiên bản…</div>
        <div class="pct" id="fbpsUpdatePct">—</div>
        <div class="bar"><i id="fbpsUpdateBar"></i></div>
        <div class="log" id="fbpsUpdateLog">Sẵn sàng.</div>
        <div class="row">
          <button type="button" class="btn-ok btn-sm" id="fbpsUpdateCheck">Kiểm tra GitHub</button>
          <button type="button" class="btn-primary btn-sm" id="fbpsUpdateApply" disabled>Cập nhật ngay</button>
          <button type="button" class="btn-ghost btn-sm" id="fbpsUpdateManual">Tải tay (Setup)</button>
          <button type="button" class="btn-ghost btn-sm" id="fbpsUpdateClose">Đóng</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener("click", (e) => {
      if (e.target === el && !busy) closePanel();
    });
    document.getElementById("fbpsUpdateClose").onclick = () => {
      if (busy && !confirm("Đang cập nhật — đóng panel? (tiến trình vẫn chạy nền)")) return;
      closePanel();
    };
    document.getElementById("fbpsUpdateCheck").onclick = () => runCheckUi(true);
    document.getElementById("fbpsUpdateApply").onclick = () => doUpdate(true);
    document.getElementById("fbpsUpdateManual").onclick = () => {
      window.open(RELEASES_URL, "_blank", "noopener");
    };
    return el;
  }

  function ensureDock() {
    let d = document.getElementById("fbpsUpdateDock");
    if (d) return d;
    d = document.createElement("div");
    d.id = "fbpsUpdateDock";
    d.innerHTML = `
      <div style="font-size:.8rem;font-weight:700">Đang cập nhật…</div>
      <div class="muted" id="fbpsDockText" style="font-size:.78rem;margin-top:.2rem">—</div>
      <div class="bar"><i id="fbpsDockBar"></i></div>`;
    d.onclick = () => openPanel();
    document.body.appendChild(d);
    return d;
  }

  function ensureBanner() {
    let el = document.getElementById("updateBanner");
    if (el) return el;
    el = document.createElement("div");
    el.id = "updateBanner";
    el.className = "update-banner";
    el.hidden = true;
    el.innerHTML = `
      <div class="update-banner-inner">
        <div class="update-banner-text">
          <strong id="updateBannerTitle">Có phiên bản mới</strong>
          <span id="updateBannerSub" class="muted"></span>
        </div>
        <div class="update-banner-actions">
          <button type="button" class="btn-ok btn-sm" id="updateBannerApply">Cập nhật ngay</button>
          <button type="button" class="btn-ghost btn-sm" id="updateBannerNotes">Xem release</button>
          <button type="button" class="btn-ghost btn-sm" id="updateBannerLater">Để sau</button>
        </div>
      </div>`;
    document.body.prepend(el);
    return el;
  }

  function openPanel() {
    ensureStyles();
    ensurePanel();
    document.getElementById("fbpsUpdatePanel").classList.add("open");
  }

  function closePanel() {
    const el = document.getElementById("fbpsUpdatePanel");
    if (el) el.classList.remove("open");
  }

  function setUiProgress({ percent, text, log }) {
    const pct = Math.max(0, Math.min(100, Number(percent) || 0));
    const bar = document.getElementById("fbpsUpdateBar");
    const dockBar = document.getElementById("fbpsDockBar");
    const pctEl = document.getElementById("fbpsUpdatePct");
    const logEl = document.getElementById("fbpsUpdateLog");
    const dockText = document.getElementById("fbpsDockText");
    const dock = ensureDock();
    if (bar) bar.style.width = `${pct}%`;
    if (dockBar) dockBar.style.width = `${pct}%`;
    if (pctEl) pctEl.textContent = text || `${pct}%`;
    if (logEl && log != null) logEl.textContent = log;
    if (dockText && text) dockText.textContent = text;
    if (busy) dock.classList.add("show");
    else dock.classList.remove("show");
    const btn = document.getElementById("btnUpdateApp");
    if (btn && busy) btn.textContent = text || `${pct}%`;
  }

  function wasDismissed(version) {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === String(version);
    } catch {
      return false;
    }
  }

  function dismiss(version) {
    try {
      sessionStorage.setItem(DISMISS_KEY, String(version));
    } catch {
      /* ignore */
    }
    const b = document.getElementById("updateBanner");
    if (b) b.hidden = true;
  }

  function showBanner(r) {
    if (!r?.has_update) return;
    if (wasDismissed(r.latest_version)) return;
    const banner = ensureBanner();
    const title = document.getElementById("updateBannerTitle");
    const sub = document.getElementById("updateBannerSub");
    if (title) title.textContent = `Có phiên bản mới v${r.latest_version}`;
    if (sub) {
      const size = r.asset
        ? ` · ${Math.round((r.asset.size || 0) / 1024 / 1024)} MB · ${r.asset.name}`
        : " · ⚠ Release chưa có file .exe";
      sub.textContent = `Bạn đang dùng v${r.current_version}${size}`;
    }
    banner.hidden = false;
    const apply = document.getElementById("updateBannerApply");
    const notes = document.getElementById("updateBannerNotes");
    const later = document.getElementById("updateBannerLater");
    if (apply) {
      apply.disabled = !r.asset;
      apply.onclick = () => {
        openPanel();
        doUpdate(true);
      };
    }
    if (notes) {
      notes.onclick = () => {
        if (r.release_url) window.open(r.release_url, "_blank", "noopener");
        else window.open(RELEASES_URL, "_blank", "noopener");
      };
    }
    if (later) later.onclick = () => dismiss(r.latest_version);
  }

  function styleBtnHasUpdate(btn, r, currentVer) {
    if (!btn || !r?.has_update) return;
    btn.textContent = `v${currentVer || r.current_version}↑ v${r.latest_version}`;
    btn.classList.remove("btn-ghost");
    btn.classList.add("btn-warn");
    btn.title = `Có bản mới v${r.latest_version} — bấm để cập nhật`;
    btn.dataset.hasUpdate = "1";
  }

  function applyCheckToPanel(r) {
    lastCheck = r;
    const sub = document.getElementById("fbpsUpdateSub");
    const apply = document.getElementById("fbpsUpdateApply");
    if (!r) {
      if (sub) sub.textContent = "Chưa kiểm tra được.";
      if (apply) apply.disabled = true;
      return;
    }
    if (!r.ok) {
      if (sub) sub.textContent = `Lỗi: ${r.error || "check fail"}`;
      if (apply) apply.disabled = true;
      setUiProgress({ percent: 0, text: "Lỗi", log: r.error || "Không kiểm tra được GitHub" });
      return;
    }
    if (r.has_update) {
      if (sub) {
        sub.textContent = `Đang dùng v${r.current_version} → có v${r.latest_version}` +
          (r.asset ? ` · ${Math.round((r.asset.size || 0) / 1024 / 1024)} MB` : " · thiếu asset EXE");
      }
      if (apply) apply.disabled = !r.asset;
      setUiProgress({
        percent: 0,
        text: `Sẵn sàng v${r.latest_version}`,
        log: r.asset
          ? `Sẽ tải: ${r.asset.name}\nSau khi xong app tự restart. License/data giữ nguyên.`
          : "Release thiếu file .exe — dùng nút Tải tay (Setup).",
      });
    } else {
      if (sub) sub.textContent = `Đang là bản mới nhất: v${r.current_version}`;
      if (apply) apply.disabled = true;
      setUiProgress({
        percent: 100,
        text: `v${r.current_version} (mới nhất)`,
        log: "Không cần cập nhật.\nNếu vẫn muốn cài lại: bấm Tải tay (Setup).",
      });
    }
  }

  async function runCheck(btn, info) {
    try {
      // Local health first — separates "tool server down" vs "GitHub blocked"
      try {
        await api("/api/version", {}, { retries: 2, kind: "local" });
      } catch (e) {
        const err = { ok: false, error: networkHint(e, "local") };
        applyCheckToPanel(err);
        if (btn) btn.title = err.error;
        return err;
      }
      const r = await api("/api/update/check", {}, { retries: 2, kind: "local" });
      lastCheck = r;
      if (!r.ok) {
        // Server reached; GitHub failed
        r.error = networkHint(r.error || "GitHub check fail", "github");
        if (btn && !btn.dataset.hasUpdate) {
          btn.title = (r.error || "Không check được") + " · " + (r.github_repo || info?.github_repo || "?");
        }
        applyCheckToPanel(r);
        return r;
      }
      if (r.has_update) {
        styleBtnHasUpdate(btn, r, info?.version || r.current_version);
        showBanner(r);
      } else if (btn) {
        btn.textContent = `v${r.current_version}`;
        btn.classList.add("btn-ghost");
        btn.classList.remove("btn-warn");
        btn.dataset.hasUpdate = "";
        btn.title = `Đang là bản mới nhất · ${r.github_repo || ""}`;
        const banner = document.getElementById("updateBanner");
        if (banner) banner.hidden = true;
      }
      applyCheckToPanel(r);
      return r;
    } catch (e) {
      const err = e.message || String(e);
      if (btn) btn.title = "Check update lỗi: " + err;
      applyCheckToPanel({ ok: false, error: err });
      return { ok: false, error: err };
    }
  }

  async function runCheckUi(open) {
    if (open) openPanel();
    const btn = document.getElementById("btnUpdateApp");
    setUiProgress({ percent: 0, text: "Checking…", log: "Đang hỏi GitHub Releases…" });
    const r = await runCheck(btn, null);
    if (!r.ok) {
      alert(r.error || "Không kiểm tra được");
      if (confirm("Mở GitHub Releases để tải tay?")) window.open(RELEASES_URL, "_blank", "noopener");
    } else if (!r.has_update) {
      // keep panel showing latest
    }
    return r;
  }

  function progressLabel(p) {
    const mb = (n) => `${(Number(n || 0) / 1024 / 1024).toFixed(1)} MB`;
    if (p.state === "checking") return p.message || "Đang kiểm tra…";
    if (p.state === "downloading") {
      return p.total
        ? `Tải ${p.percent || 0}% · ${mb(p.bytes)} / ${mb(p.total)}`
        : `Tải ${mb(p.bytes)}`;
    }
    if (p.state === "ready") return "Đã tải xong — chuẩn bị restart…";
    if (p.state === "restarting") return "Đang thay EXE & mở lại…";
    if (p.state === "error") return p.error || p.message || "Lỗi";
    return p.message || p.state || "…";
  }

  /**
   * Poll progress until terminal state.
   * IMPORTANT: do not treat early idle as success (race with apply start).
   */
  async function watchUpdateProgress(sessionStartedAt) {
    const deadline = Date.now() + 45 * 60 * 1000;
    let sawActive = false;
    let sawDownload = false;
    let idleStreak = 0;

    while (Date.now() < deadline) {
      let p;
      try {
        p = await api("/api/update/progress");
      } catch (e) {
        // Server may die mid-restart — treat as restarting if we already downloaded
        if (sawDownload) {
          setUiProgress({
            percent: 100,
            text: "Restarting…",
            log: "Mất kết nối server (thường do app đang restart sau update).\nChờ vài giây — nếu không tự mở, chạy lại EXE mới.",
          });
          return { restarting: true, progress: { state: "restarting" } };
        }
        throw e;
      }

      if (p.active) sawActive = true;
      if (p.state === "downloading" || p.state === "checking" || p.state === "ready") sawDownload = true;

      const pct =
        p.state === "downloading"
          ? Number(p.percent) || 0
          : p.state === "ready" || p.state === "restarting"
            ? 100
            : p.state === "checking"
              ? 2
              : 0;
      setUiProgress({
        percent: pct,
        text: progressLabel(p),
        log:
          `${p.message || progressLabel(p)}\n` +
          `state=${p.state} active=${p.active ? "yes" : "no"}\n` +
          (p.from && p.to ? `${p.from} → ${p.to}` : ""),
      });

      if (p.state === "error") throw new Error(p.error || "Tải update thất bại");
      if (p.state === "ready" || p.state === "restarting") {
        return { restarting: true, progress: p };
      }

      // Only accept idle as "already latest" if we never entered an update session
      // and enough time passed that apply should have flipped to checking.
      if (p.state === "idle" && !p.active) {
        if (!sawActive && !sawDownload && Date.now() - sessionStartedAt > 2500) {
          idleStreak += 1;
          if (idleStreak >= 3) return { latest: true, progress: p };
        } else if (sawDownload && !p.active) {
          // Download finished and worker cleared — wait for restart signal
          idleStreak += 1;
          if (idleStreak >= 8) {
            return { restarting: true, progress: p };
          }
        } else {
          idleStreak = 0;
        }
      } else {
        idleStreak = 0;
      }

      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error("Tải update quá lâu (>45 phút). Kiểm tra mạng rồi bấm lại, hoặc Tải tay Setup.");
  }

  async function doUpdate(fromPanel) {
    if (busy) {
      openPanel();
      return;
    }
    if (fromPanel) openPanel();
    const btn = document.getElementById("btnUpdateApp");
    const applyBtn = document.getElementById("fbpsUpdateApply");
    const bannerApply = document.getElementById("updateBannerApply");
    busy = true;
    if (btn) btn.disabled = true;
    if (applyBtn) applyBtn.disabled = true;
    if (bannerApply) bannerApply.disabled = true;

    try {
      setUiProgress({ percent: 0, text: "Checking…", log: "1) Server tool…\n2) GitHub Releases…" });
      try {
        await api("/api/version", {}, { retries: 2, kind: "local" });
      } catch (e) {
        throw new Error(networkHint(e, "local"));
      }
      const check = await api("/api/update/check", {}, { retries: 2, kind: "local" });
      lastCheck = check;
      applyCheckToPanel(check);
      if (!check.ok) throw new Error(networkHint(check.error || "Check fail", "github"));
      if (!check.has_update) {
        alert(`Đã là bản mới nhất: v${check.current_version}`);
        return;
      }
      if (!check.asset) {
        alert(
          `Release v${check.latest_version} chưa có file .exe.\n` +
            `Dùng nút Tải tay (Setup) trên GitHub.`
        );
        window.open(check.release_url || RELEASES_URL, "_blank", "noopener");
        return;
      }

      const ok = confirm(
        `Cập nhật TẠI CHỖ?\n\n` +
          `v${check.current_version} → v${check.latest_version}\n` +
          `File: ${check.asset.name} (~${Math.round((check.asset.size || 0) / 1024 / 1024)} MB)\n\n` +
          `• Tải từ GitHub → thay EXE → app tự mở lại\n` +
          `• EXE bản cũ cùng thư mục sẽ bị xóa\n` +
          `• License + data giữ nguyên\n\n` +
          `Nếu mạng chặn GitHub: Cancel rồi bấm Tải tay (Setup).`
      );
      if (!ok) return;

      setUiProgress({
        percent: 1,
        text: "Bắt đầu tải…",
        log: `POST /api/update/apply\n${check.asset.name}`,
      });

      const startedAt = Date.now();
      const started = await api("/api/update/apply", {
        method: "POST",
        body: JSON.stringify({ restart: true }),
      });
      if (!started.ok) throw new Error(started.error || "Không thể bắt đầu update");

      if (started.progress) {
        setUiProgress({
          percent: started.progress.percent || 1,
          text: progressLabel(started.progress),
          log: started.progress.message || "Download started",
        });
      }

      const finished = await watchUpdateProgress(startedAt);
      if (finished.latest) {
        alert("Đã là bản mới nhất (hoặc phiên cập nhật không chạy).");
      } else if (finished.restarting) {
        setUiProgress({
          percent: 100,
          text: "Restarting…",
          log: "App đang đóng và thay file EXE.\nNếu 15s không mở lại: chạy file Desktop-v…exe mới trong thư mục app.",
        });
        // Keep busy — process should exit
        return;
      }
    } catch (e) {
      const text = networkHint(e);
      setUiProgress({ percent: 0, text: "Lỗi", log: text });
      alert(text);
      if (/failed to fetch|github|mạng|network|HTTP|timeout|tải tay/i.test(text)) {
        if (confirm("Mở trang GitHub Releases để tải Setup bằng tay?")) {
          window.open(RELEASES_URL, "_blank", "noopener");
        }
      }
    } finally {
      // If still here, update didn't restart the process
      busy = false;
      ensureDock().classList.remove("show");
      if (btn) btn.disabled = false;
      if (applyBtn) applyBtn.disabled = !(lastCheck && lastCheck.has_update && lastCheck.asset);
      if (bannerApply) bannerApply.disabled = false;
    }
  }

  async function showLastUpdateError() {
    try {
      const r = await api("/api/update/last-error");
      if (!r?.has_error) return;
      alert(
        `LẦN CẬP NHẬT TRƯỚC THẤT BẠI\n\n${r.error}\n\n` +
          "Tool vẫn bản cũ. Bấm Cập nhật lại hoặc cài Setup tay."
      );
      await api("/api/update/last-error/clear", { method: "POST", body: "{}" });
    } catch {
      /* ignore */
    }
  }

  function wireNavLinks() {
    // Any sidebar "Cập nhật" / #navUpdate must open panel (not silent no-op)
    document.querySelectorAll("#navUpdate, a.nav-item").forEach((a) => {
      const t = (a.textContent || "").toLowerCase();
      if (a.id === "navUpdate" || t.includes("cập nhật phiên bản") || t.includes("cap nhat phien ban")) {
        a.addEventListener("click", (e) => {
          e.preventDefault();
          openPanel();
          runCheckUi(false);
        });
      }
    });
  }

  async function init() {
    ensureStyles();
    ensureBanner();
    ensurePanel();
    ensureDock();
    wireNavLinks();
    await showLastUpdateError();

    const btn = ensureBtn();
    let info = null;
    try {
      info = await api("/api/version");
      if (btn) {
        btn.textContent = `v${info.version}`;
        btn.title = info.github_repo
          ? `Repo: ${info.github_repo} — bấm mở panel cập nhật`
          : "Bấm mở panel cập nhật";
      }
      const sub = document.getElementById("fbpsUpdateSub");
      if (sub) sub.textContent = `Bản hiện tại: v${info.version} · ${info.github_repo || ""}`;
    } catch (e) {
      if (btn) {
        btn.textContent = "Update";
        btn.title = networkHint(e);
      }
      setUiProgress({ percent: 0, text: "Offline?", log: networkHint(e) });
    }

    if (btn) {
      btn.onclick = () => {
        openPanel();
        if (btn.dataset.hasUpdate === "1") doUpdate(true);
        else runCheckUi(false);
      };
    }

    // Auto-check (silent) — still fills banner if update exists
    await runCheck(btn, info);
    setInterval(() => runCheck(btn, info), RECHECK_MS);
  }

  // Global so sidebar inline onclick can call even before button exists
  window.fbpsOpenUpdate = function fbpsOpenUpdate() {
    openPanel();
    runCheckUi(false);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
