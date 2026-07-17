/** Version check + update button for FB Page Studio */
(function () {
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
      document.querySelector("header .actions");
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

  async function init() {
    const btn = ensureBtn();
    if (!btn) return;

    let info = null;
    try {
      info = await api("/api/version");
      btn.textContent = `v${info.version}`;
      btn.title = info.github_repo
        ? `Repo: ${info.github_repo} — bấm để kiểm tra cập nhật`
        : "Chưa set GITHUB_REPO trong .env — bấm để xem hướng dẫn";
    } catch {
      btn.textContent = "Update";
    }

    btn.onclick = async () => {
      btn.disabled = true;
      const prev = btn.textContent;
      btn.textContent = "Checking…";
      try {
        const r = await api("/api/update/check");
        if (!r.ok) {
          alert(
            (r.error || "Không kiểm tra được") +
              "\n\nĐặt GITHUB_REPO=owner/repo trong file .env cạnh app.\nTạo GitHub Release có file FB-Page-Studio.exe"
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
        const notes = (r.release_notes || "").slice(0, 500);
        const ok = confirm(
          `Có bản mới!\n\nHiện tại: v${r.current_version}\nMới: v${r.latest_version}\n` +
            (r.asset ? `File: ${r.asset.name} (${Math.round((r.asset.size || 0) / 1024 / 1024)} MB)\n` : "⚠ Release chưa có file .exe\n") +
            (notes ? `\n---\n${notes}\n` : "") +
            `\nTải và cập nhật ngay? App sẽ tự khởi động lại.`
        );
        if (!ok) return;
        if (!r.asset) {
          if (r.release_url) window.open(r.release_url, "_blank");
          return;
        }
        btn.textContent = "Downloading…";
        const up = await api("/api/update/apply", {
          method: "POST",
          body: JSON.stringify({ restart: true }),
        });
        if (up.ok && up.updated) {
          alert(up.message || "Đang cập nhật — app sẽ đóng và mở lại.");
        } else {
          alert(up.error || up.message || "Update thất bại");
        }
      } catch (e) {
        alert(e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = prev;
      }
    };

    // Soft auto-check once (badge style if update available)
    try {
      const r = await api("/api/update/check");
      if (r.ok && r.has_update) {
        btn.textContent = `v${info?.version || "?"}↑`;
        btn.classList.remove("btn-ghost");
        btn.classList.add("btn-warn");
        btn.title = `Có bản mới v${r.latest_version} — bấm để cập nhật`;
      }
    } catch {
      /* offline / no repo */
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
