/** Shared navigation and responsive shell for every screen.
 *  Same-page hash changes update view in-place (no full reload) to avoid UI freeze.
 */
(function () {
  const side = document.getElementById("sidebar");
  const btn = document.getElementById("menuBtn");
  const back = document.getElementById("sidebarBackdrop");

  function currentPath() {
    return location.pathname === "/" ? "/index.html" : location.pathname;
  }

  function resolveView(path, hash) {
    if (path === "/app.html" && hash === "#jobSection") return "progress";
    if (path === "/app.html" && hash === "#logsSection") return "reports";
    if (path === "/app.html") return "overview";
    if (path === "/posting.html" && hash === "#rotationWorkspace") return "rotation";
    if (path === "/posting.html" && hash === "#bulkWorkspace") return "rotation";
    if (path === "/posting.html") return "configuration";
    if (path === "/index.html") return "connections";
    if (path === "/pages-hub.html") return "pages_hub";
    if (path === "/delete-posts.html") return "delete_posts";
    if (path === "/delete-group-posts.html") return "delete_groups";
    if (path === "/antispam.html") return "safety";
    if (path === "/license.html") return "license";
    return "default";
  }

  /** Normalize empty hash on posting → config workspace for nav highlight. */
  function effectiveHash(path, hash) {
    if (path === "/posting.html" && !hash) return "#configWorkspace";
    return hash || "";
  }

  const items = [
    ["/app.html", "⌂", "Tổng quan", "Theo dõi hệ thống và tiến trình"],
    ["/index.html", "1", "Kết nối Meta", "OAuth App & sync Page (an toàn)"],
    ["/pages-hub.html", "▣", "Quản lý Fanpage", "Tài khoản → Page · insights · đề xuất"],
    ["/posting.html#configWorkspace", "2", "Cấu hình Page", "Media, caption và giới hạn"],
    ["/posting.html#rotationWorkspace", "3", "Lập lịch & chạy", "Chạy ngay hoặc hẹn giờ"],
    ["/delete-posts.html", "⌫", "Xóa bài Page", "Xóa feed Fanpage siêu nhanh"],
    ["/delete-group-posts.html", "⊟", "Xóa bài Group", "Admin/Mod xóa feed Group"],
    ["/app.html#jobSection", "4", "Tiến trình", "Phần trăm, OK và lỗi"],
    ["/antispam.html", "5", "An toàn Anti-spam", "Quota và cooldown"],
    ["/app.html#logsSection", "6", "Báo cáo", "Lịch sử và file xuất"],
    ["/license.html", "◆", "License", "Kích hoạt thiết bị"],
  ];

  const viewInfo = {
    overview: ["TỔNG QUAN", "Theo dõi sức khỏe toàn hệ thống", "blue"],
    connections: ["KẾT NỐI", "Quản lý Meta App, Profile và Page", "violet"],
    pages_hub: ["FANPAGE", "Tài khoản OAuth · Page · Insights · Chất lượng · Đề xuất", "cyan"],
    configuration: ["CẤU HÌNH PAGE", "Thiết lập nội dung và giới hạn từng Page", "cyan"],
    rotation: ["LẬP LỊCH & CHẠY", "Xếp vòng đăng, thời gian và bắt đầu job", "green"],
    delete_posts: ["XÓA BÀI", "Xóa bài Fanpage hàng loạt bằng Graph API", "red"],
    delete_groups: ["XÓA GROUP", "Xóa bài Group với quyền Admin/Mod", "red"],
    progress: ["TIẾN TRÌNH", "Theo dõi phần trăm, nhiệm vụ và lỗi", "orange"],
    safety: ["AN TOÀN", "Kiểm soát quota, cooldown và anti-spam", "red"],
    reports: ["BÁO CÁO", "Đối soát Facebook và lịch sử đăng", "yellow"],
    license: ["LICENSE", "Kích hoạt và giới hạn thiết bị", "violet"],
  };

  const titles = {
    overview: "Tổng quan hệ thống",
    connections: "Kết nối Meta & Page (OAuth)",
    pages_hub: "Quản lý Fanpage (Graph API)",
    configuration: "Cấu hình nội dung Page",
    rotation: "Lập lịch và bắt đầu chạy",
    delete_posts: "Xóa bài Fanpage siêu nhanh",
    delete_groups: "Xóa bài Group (Admin/Mod)",
    progress: "Tiến trình công việc",
    safety: "An toàn Anti-spam",
    reports: "Báo cáo và đối soát",
    license: "License thiết bị",
  };

  function buildNav(path, hash) {
    const normHash = effectiveHash(path, hash);
    return items
      .map(([href, icon, title, sub]) => {
        const targetPath = href.split("#")[0];
        const itemHash = href.includes("#") ? "#" + href.split("#")[1] : "";
        const active =
          path === targetPath &&
          (normHash ? itemHash === normHash : !itemHash);
        return `<a class="nav-item ${active ? "active" : ""}" href="${href}">
        <span class="ico">${icon}</span><span class="nav-copy"><b>${title}</b><small>${sub}</small></span>
      </a>`;
      })
      .join("");
  }

  function ensureSidebar() {
    if (!side) return;
    const path = currentPath();
    const hash = location.hash || "";
    if (side.dataset.shellReady === "1") {
      updateNavActive(path, hash);
      return;
    }
    side.innerHTML = `
      <a class="brand" href="/app.html">
        <span class="brand-mark">FS</span>
        <span class="brand-text"><strong>FB Studio Pro</strong><span>Publishing workspace</span></span>
      </a>
      <div class="nav-label">Quy trình vận hành</div>
      <nav class="nav-stack">${buildNav(path, hash)}</nav>
      <div class="nav-foot">
        <div class="system-pill"><i></i><span id="shellSystemText">Đang kiểm tra hệ thống…</span></div>
        <div class="meta" id="shellClock">Giờ Việt Nam</div>
        <div class="meta" id="reportPath" style="margin-top:.45rem;word-break:break-word">Báo cáo: data/exports/</div>
      </div>`;
    side.dataset.shellReady = "1";
    side.querySelectorAll("a").forEach((a) => a.addEventListener("click", close));
  }

  function updateNavActive(path, hash) {
    if (!side) return;
    const normHash = effectiveHash(path, hash);
    side.querySelectorAll(".nav-item").forEach((a) => {
      const href = a.getAttribute("href") || "";
      const targetPath = href.split("#")[0];
      const itemHash = href.includes("#") ? "#" + href.split("#")[1] : "";
      const active =
        path === targetPath && (normHash ? itemHash === normHash : !itemHash);
      a.classList.toggle("active", active);
    });
  }

  function applyChrome(view) {
    document.body.dataset.view = view;
    const info = viewInfo[view];
    const titleBox = document.querySelector(".topbar-left > div");
    if (!info || !titleBox) return;

    let eyebrow = titleBox.querySelector(".view-eyebrow");
    if (!eyebrow) {
      eyebrow = document.createElement("div");
      eyebrow.className = `view-eyebrow ${info[2]}`;
      titleBox.prepend(eyebrow);
    } else {
      eyebrow.className = `view-eyebrow ${info[2]}`;
    }
    eyebrow.textContent = info[0];

    const sub = titleBox.querySelector(".sub");
    if (sub) sub.textContent = info[1];
    const h1 = titleBox.querySelector("h1");
    if (h1 && titles[view]) h1.textContent = titles[view];
  }

  function applyShellView({ scroll = false } = {}) {
    const path = currentPath();
    const hash = location.hash || "";
    const view = resolveView(path, hash);
    applyChrome(view);
    updateNavActive(path, hash);
    if (scroll && hash) {
      const el = document.querySelector(hash);
      if (el) {
        requestAnimationFrame(() => {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }
    }
    window.dispatchEvent(
      new CustomEvent("shell:viewchange", { detail: { view, hash, path } })
    );
  }

  function close() {
    side?.classList.remove("open");
    back?.classList.remove("open");
  }
  function open() {
    side?.classList.add("open");
    back?.classList.add("open");
  }

  ensureSidebar();
  applyShellView({ scroll: !!location.hash });

  btn?.addEventListener("click", () =>
    side?.classList.contains("open") ? close() : open()
  );
  back?.addEventListener("click", close);

  function updateClock() {
    const el = document.getElementById("shellClock");
    if (el) {
      el.textContent =
        new Date().toLocaleString("vi-VN", {
          timeZone: "Asia/Ho_Chi_Minh",
          hour12: false,
        }) + " · giờ VN";
    }
  }
  updateClock();
  setInterval(updateClock, 1000);

  fetch("/api/runtime")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
    .then((r) => {
      const s = r.scheduler || {};
      const el = document.getElementById("shellSystemText");
      if (el) {
        el.textContent = s.enabled_pages
          ? `Online · ${s.enabled_pages} Page tự động`
          : "Online · chưa bật Page tự động";
      }
    })
    .catch(() => {
      const el = document.getElementById("shellSystemText");
      if (el) el.textContent = "Không kết nối được server";
      side?.querySelector(".system-pill")?.classList.add("offline");
    });

  // SPA-style: same-page hash nav updates view without reload (fixes freeze / "click no switch")
  window.addEventListener("hashchange", () => {
    applyShellView({ scroll: true });
  });

  // Expose for pages that replaceState without firing hashchange
  window.__fbShellApplyView = applyShellView;
})();
