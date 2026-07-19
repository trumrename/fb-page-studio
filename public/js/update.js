/**
 * Auto-check GitHub Releases · banner thông báo · bấm Cập nhật là tải + restart
 * - Check khi mở trang + lặp mỗi 4 giờ
 * - Nút topbar hiển thị version hiện tại và tiến trình khi có bản mới
 */
(function () {
  const RECHECK_MS = 4 * 60 * 60 * 1000;
  const DISMISS_KEY = "fbps_update_dismiss_v";

  async function api(path, opts) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function ensureBtn() {
    let btn = document.getElementById("btnUpdateApp");
    if (btn) return btn;
    const host =
      document.querySelector(".topbar-actions") ||
      document.querySelector("header .actions") ||
      document.querySelector(".topbar");
    if (!host) return null;
    btn = document.createElement("button");
    btn.type = "button";
    btn.id = "btnUpdateApp";
    btn.className = "btn-ghost btn-sm";
    btn.textContent = "v…";
    btn.title = "Kiểm tra / cập nhật phiên bản từ GitHub";
    host.appendChild(btn);
    return btn;
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
    if (title) {
      title.textContent = `Có phiên bản mới v${r.latest_version}`;
    }
    if (sub) {
      const size = r.asset
        ? ` · ${Math.round((r.asset.size || 0) / 1024 / 1024)} MB · ${r.asset.name}`
        : " · ⚠ Release chưa có file .exe — mở GitHub để tải";
      sub.textContent = `Bạn đang dùng v${r.current_version}${size}`;
    }
    banner.hidden = false;

    const apply = document.getElementById("updateBannerApply");
    const notes = document.getElementById("updateBannerNotes");
    const later = document.getElementById("updateBannerLater");
    if (apply) {
      apply.disabled = !r.asset;
      apply.onclick = () => doUpdate(apply);
    }
    if (notes) {
      notes.onclick = () => {
        if (r.release_url) window.open(r.release_url, "_blank", "noopener");
      };
    }
    if (later) {
      later.onclick = () => dismiss(r.latest_version);
    }
  }

  function styleBtnHasUpdate(btn, r, currentVer) {
    if (!btn || !r?.has_update) return;
    btn.textContent = `v${currentVer || r.current_version}↑ v${r.latest_version}`;
    btn.classList.remove("btn-ghost");
    btn.classList.add("btn-warn");
    btn.title = `Có bản mới v${r.latest_version} — bấm để cập nhật`;
    btn.dataset.hasUpdate = "1";
  }

  function updateProgressText(p) {
    const mb = (n) => `${(Number(n || 0) / 1024 / 1024).toFixed(1)} MB`;
    if (p.state === "downloading") {
      return p.total
        ? `Đang tải ${p.percent || 0}% · ${mb(p.bytes)} / ${mb(p.total)}`
        : `Đang tải ${mb(p.bytes)}`;
    }
    return p.message || "Đang chuẩn bị cập nhật…";
  }

  async function watchUpdateProgress(btn, applyBtn) {
    const deadline = Date.now() + 30 * 60 * 1000;
    while (Date.now() < deadline) {
      const p = await api("/api/update/progress");
      const label = updateProgressText(p);
      if (btn) btn.textContent = label;
      if (applyBtn) applyBtn.textContent = label;
      if (p.state === "error") throw new Error(p.error || "Tải update thất bại");
      if (p.state === "idle" && !p.active) return { latest: true, progress: p };
      if (p.state === "ready" || p.state === "restarting") {
        if (btn) btn.textContent = "Đang khởi động lại…";
        if (applyBtn) applyBtn.textContent = "Đang khởi động lại…";
        return { restarting: true, progress: p };
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    throw new Error("Tải update quá lâu. Kiểm tra mạng rồi bấm lại.");
  }

  async function doUpdate(uiBtn) {
    const btn = uiBtn || document.getElementById("btnUpdateApp");
    let restarting = false;
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Đang tải…";
    }
    const applyBtn = document.getElementById("updateBannerApply");
    if (applyBtn) {
      applyBtn.disabled = true;
      applyBtn.textContent = "Đang tải…";
    }
    try {
      const check = await api("/api/update/check");
      if (!check.ok) throw new Error(check.error || "Check fail");
      if (!check.has_update) {
        alert(`Đã là bản mới nhất: v${check.current_version}`);
        return;
      }
      if (!check.asset) {
        alert(
          `Release v${check.latest_version} trên GitHub chưa có file .exe.\n` +
            `Không thể cập nhật tại chỗ — chờ admin upload asset lên Release\n` +
            `(không cần tải bản khác về Downloads).`
        );
        // Do NOT force-open GitHub as a "second product" — optional only
        return;
      }
      const ok = confirm(
        `Cập nhật TẠI CHỖ (cùng app, cùng file .exe)?\n\n` +
          `v${check.current_version} → v${check.latest_version}\n` +
          `Nguồn: GitHub ${check.asset.name}\n` +
          `→ Ghi đè file đang chạy, KHÔNG tạo bản app khác.\n` +
          `License + data giữ nguyên. App tự mở lại.`
      );
      if (!ok) return;

      const started = await api("/api/update/apply", {
        method: "POST",
        body: JSON.stringify({ restart: true }),
      });
      if (!started.ok) throw new Error(started.error || "Không thể bắt đầu update");
      const finished = await watchUpdateProgress(btn, applyBtn);
      if (finished.latest) {
        alert("Đã là bản mới nhất.");
      } else if (finished.restarting) {
        // Electron exits immediately after this; no CMD window is shown.
        restarting = true;
        return;
      }
    } catch (e) {
      alert(e.message || String(e));
    } finally {
      if (btn && !restarting) btn.disabled = false;
      if (applyBtn && !restarting) {
        applyBtn.disabled = false;
        applyBtn.textContent = "Cập nhật ngay";
      }
    }
  }

  async function runCheck(btn, info) {
    try {
      const r = await api("/api/update/check");
      if (!r.ok) {
        if (btn && !btn.dataset.hasUpdate) {
          btn.title =
            (r.error || "Không check được") +
            " · Repo: " +
            (r.github_repo || info?.github_repo || "?");
        }
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
      return r;
    } catch (e) {
      if (btn) btn.title = "Check update lỗi: " + (e.message || e);
      return null;
    }
  }

  async function showLastUpdateError() {
    try {
      const r = await api("/api/update/last-error");
      if (!r?.has_error) return;
      alert(
        `LẦN CẬP NHẬT TRƯỚC THẤT BẠI\n\n${r.error}\n\n` +
          "Tool vẫn đang chạy bản cũ. Hãy bấm cập nhật lại hoặc chép đè EXE thủ công."
      );
      await api("/api/update/last-error/clear", { method: "POST", body: "{}" });
    } catch {
      /* update diagnostics must not block the app */
    }
  }

  async function init() {
    await showLastUpdateError();
    const btn = ensureBtn();
    ensureBanner();

    let info = null;
    try {
      info = await api("/api/version");
      if (btn) {
        btn.textContent = `v${info.version}`;
        btn.title = info.github_repo
          ? `Repo: ${info.github_repo} — bấm kiểm tra / cập nhật`
          : "Bấm để kiểm tra cập nhật GitHub";
      }
    } catch {
      if (btn) btn.textContent = "Update";
    }

    if (btn) {
      btn.onclick = async () => {
        if (btn.dataset.hasUpdate === "1") {
          await doUpdate(btn);
          return;
        }
        btn.disabled = true;
        const prev = btn.textContent;
        btn.textContent = "Checking…";
        try {
          const r = await runCheck(btn, info);
          if (!r) return;
          if (!r.ok) {
            alert(
              (r.error || "Không kiểm tra được") +
                "\n\nGITHUB_REPO mặc định: trumrename/fb-page-studio\n" +
                "Tạo GitHub Release có file FB-Page-Studio-Desktop-vX.Y.Z.exe"
            );
            return;
          }
          if (!r.has_update) {
            alert(
              `Bạn đang dùng bản mới nhất: v${r.current_version}` +
                (r.release_url ? `\n\n${r.release_url}` : "")
            );
            return;
          }
          // has update — banner already shown; offer apply
          await doUpdate(btn);
        } catch (e) {
          alert(e.message);
        } finally {
          btn.disabled = false;
          if (btn.dataset.hasUpdate !== "1") btn.textContent = prev;
        }
      };
    }

    // Auto-check on load
    await runCheck(btn, info);
    // Recheck while app stays open
    setInterval(() => runCheck(btn, info), RECHECK_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
