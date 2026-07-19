/** Shared navigation and responsive shell for every screen. */
(function () {
  const side = document.getElementById("sidebar");
  const btn = document.getElementById("menuBtn");
  const back = document.getElementById("sidebarBackdrop");
  const path = location.pathname === "/" ? "/index.html" : location.pathname;
  const hash = location.hash || "";
  const view =
    path === "/app.html" && hash === "#jobSection" ? "progress" :
    path === "/app.html" && hash === "#logsSection" ? "reports" :
    path === "/app.html" ? "overview" :
    path === "/posting.html" && hash === "#rotationWorkspace" ? "rotation" :
    path === "/posting.html" ? "configuration" :
    path === "/index.html" ? "connections" :
    path === "/antispam.html" ? "safety" :
    path === "/license.html" ? "license" : "default";
  document.body.dataset.view = view;

  const items = [
    ["/app.html", "⌂", "Tổng quan", "Theo dõi hệ thống và tiến trình"],
    ["/index.html", "1", "Kết nối Meta", "App, Profile và Page"],
    ["/posting.html#configWorkspace", "2", "Cấu hình Page", "Media, caption và giới hạn"],
    ["/posting.html#rotationWorkspace", "3", "Lập lịch & chạy", "Chạy ngay hoặc hẹn giờ"],
    ["/app.html#jobSection", "4", "Tiến trình", "Phần trăm, OK và lỗi"],
    ["/antispam.html", "5", "An toàn Anti-spam", "Quota và cooldown"],
    ["/app.html#logsSection", "6", "Báo cáo", "Lịch sử và file xuất"],
    ["/license.html", "◆", "License", "Kích hoạt thiết bị"],
  ];

  if (side) {
    const nav = items.map(([href, icon, title, sub]) => {
      const targetPath = href.split("#")[0];
      const itemHash = href.includes("#") ? "#" + href.split("#")[1] : "";
      const active = path === targetPath && (hash ? itemHash === hash : !itemHash);
      return `<a class="nav-item ${active ? "active" : ""}" href="${href}">
        <span class="ico">${icon}</span><span class="nav-copy"><b>${title}</b><small>${sub}</small></span>
      </a>`;
    }).join("");
    side.innerHTML = `
      <a class="brand" href="/app.html">
        <span class="brand-mark">FS</span>
        <span class="brand-text"><strong>FB Studio Pro</strong><span>Publishing workspace</span></span>
      </a>
      <div class="nav-label">Quy trình vận hành</div>
      <nav class="nav-stack">${nav}</nav>
      <div class="nav-foot">
        <div class="system-pill"><i></i><span id="shellSystemText">Đang kiểm tra hệ thống…</span></div>
        <div class="meta" id="shellClock">Giờ Việt Nam</div>
        <div class="meta" id="reportPath" style="margin-top:.45rem;word-break:break-word">Báo cáo: data/exports/</div>
      </div>`;
  }

  const viewInfo = {
    overview: ["TỔNG QUAN", "Theo dõi sức khỏe toàn hệ thống", "blue"],
    connections: ["KẾT NỐI", "Quản lý Meta App, Profile và Page", "violet"],
    configuration: ["CẤU HÌNH PAGE", "Thiết lập nội dung và giới hạn từng Page", "cyan"],
    rotation: ["LẬP LỊCH & CHẠY", "Xếp vòng đăng, thời gian và bắt đầu job", "green"],
    progress: ["TIẾN TRÌNH", "Theo dõi phần trăm, nhiệm vụ và lỗi", "orange"],
    safety: ["AN TOÀN", "Kiểm soát quota, cooldown và anti-spam", "red"],
    reports: ["BÁO CÁO", "Đối soát Facebook và lịch sử đăng", "yellow"],
    license: ["LICENSE", "Kích hoạt và giới hạn thiết bị", "violet"],
  };
  const info = viewInfo[view];
  const titleBox = document.querySelector(".topbar-left > div");
  if (info && titleBox) {
    const eyebrow = document.createElement("div");
    eyebrow.className = `view-eyebrow ${info[2]}`;
    eyebrow.textContent = info[0];
    titleBox.prepend(eyebrow);
    const sub = titleBox.querySelector(".sub");
    if (sub) sub.textContent = info[1];
    const titles = {
      overview: "Tổng quan hệ thống", connections: "Kết nối Meta & Page",
      configuration: "Cấu hình nội dung Page", rotation: "Lập lịch và bắt đầu chạy",
      progress: "Tiến trình công việc", safety: "An toàn Anti-spam",
      reports: "Báo cáo và đối soát", license: "License thiết bị",
    };
    const h1 = titleBox.querySelector("h1");
    if (h1 && titles[view]) h1.textContent = titles[view];
  }

  function close() {
    side?.classList.remove("open");
    back?.classList.remove("open");
  }
  function open() {
    side?.classList.add("open");
    back?.classList.add("open");
  }
  btn?.addEventListener("click", () => side?.classList.contains("open") ? close() : open());
  back?.addEventListener("click", close);
  side?.querySelectorAll("a").forEach((a) => a.addEventListener("click", close));

  function updateClock() {
    const el = document.getElementById("shellClock");
    if (el) el.textContent = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false }) + " · giờ VN";
  }
  updateClock();
  setInterval(updateClock, 1000);

  fetch("/api/runtime")
    .then((r) => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
    .then((r) => {
      const s = r.scheduler || {};
      const el = document.getElementById("shellSystemText");
      if (el) el.textContent = s.enabled_pages ? `Online · ${s.enabled_pages} Page tự động` : "Online · chưa bật Page tự động";
    })
    .catch(() => {
      const el = document.getElementById("shellSystemText");
      if (el) el.textContent = "Không kết nối được server";
      side?.querySelector(".system-pill")?.classList.add("offline");
    });

  window.addEventListener("hashchange", () => location.reload());
})();
