# FB Page Studio — Tổng quan tool

**1 app desktop Windows** quản lý nhiều tài khoản Facebook + nhiều Fanpage, đăng bài / hẹn giờ / xóa hàng loạt qua **Facebook Graph API chính thức**.

| | |
|--|--|
| **Tên** | FB Page Studio |
| **Phiên bản hiện tại** | **v1.2.72** (2026-07-29) |
| **Loại** | SAFE — OAuth + Graph only (không cookie / id\|pass trong bản chính) |
| **Máy DEV (source)** | `C:\Users\NCpc\fb-page-poster\` (có thể mirror `D:\` / `F:\`) |
| **Data runtime (Setup)** | `%APPDATA%\fb-page-studio\` (`.env`, `data\app.db`, license, media) |
| **GitHub** | https://github.com/trumrename/fb-page-studio |
| **Tải Setup (latest)** | https://github.com/trumrename/fb-page-studio/releases/latest/download/FB-Page-Studio-Setup.exe |
| **OAuth relay** | `https://modelswiki.top` · `OAUTH_RELAY=1` |

**Chỉ mục docs:** `DOC-INDEX.md`

---

## 1. Mục tiêu sản phẩm

| Làm được | Không làm / không hứa |
|----------|------------------------|
| Multi-account OAuth official | Cookie browser / auto-login dev.facebook (tool Session riêng) |
| Multi Meta App (App1, App2, …) | Vượt rate limit Meta (#4) |
| Publish feed text/ảnh/video · caption pool · anti-spam | Xóa 100% mọi object Graph cấm (#200) |
| Direct Local (tool canh giờ) hoặc hẹn Facebook | Crack / giả extension Chrome |
| Rotation so-le app/page | Story full (có module Story riêng theo version) |
| **Xóa hàng loạt** Fanpage (batch 50) + filter ngày | Visitor post (cần quyền + App Review) |
| Xóa **share của page** (`shared_story`) — đã live-test | Cover/avatar upload tay (same-app only) |
| License key · update từ GitHub Releases | — |

---

## 2. Kiến trúc ngắn

```
┌──────────────────────────────────────────────────────────┐
│  Electron (main.cjs)                                     │
│  - Cửa sổ UI · tray · mở browser OAuth (Portable-safe) │
│  - Spawn server Node bằng chính binary Electron          │
└───────────────────────┬──────────────────────────────────┘
                        │ http://127.0.0.1:PORT
┌───────────────────────▼──────────────────────────────────┐
│  Express (src/server.js)                                 │
│  /auth OAuth · /api pages/jobs · /api/delete-posts · …   │
│  better-sqlite3 · encrypt tokens · license · updater     │
└───────────────────────┬──────────────────────────────────┘
                        │ Graph API v21+
┌───────────────────────▼──────────────────────────────────┐
│  Meta: OAuth relay modelswiki.top · Page access tokens   │
└──────────────────────────────────────────────────────────┘
```

| Thành phần | Path |
|------------|------|
| UI HTML | `public/` (`app.html`, `posting.html`, `delete-posts.html`, …) |
| Graph helpers | `src/services/facebook.js` |
| Xóa Fanpage | `src/services/deletePosts.js` · `src/routes/deletePosts.js` |
| Rate limit | `src/services/rateLimit.js` (GLOBAL pause #4, adaptive batch) |
| Desktop | `electron/main.cjs` |
| OAuth relay (server) | `oauth-relay/` |
| Session cookie (tách tool) | `ENABLE_HTTP_OPS=1` hoặc project **fb-session-ops** — **không** bật mặc định bản SAFE |

---

## 3. Hai nơi lưu — đừng nhầm

```
┌─ MÁY DEV ─────────────────────────────────────────────┐
│  C:\Users\NCpc\fb-page-poster\   (source)             │
│  src\ public\ electron\ scripts\                      │
│  keys\license-private.pem  ← KHÔNG ship khách         │
│  Tổng Hợp Tool\pack-dev\ pack-customer\               │
│  Build Setup: F:\FB-Page-Studio\dist-desktop-oauth\   │
└───────────────────────────────────────────────────────┘

┌─ MÁY KHÁCH (Setup NSIS) ──────────────────────────────┐
│  Cài: Program Files\FB Page Studio\  (code)           │
│  Data: %APPDATA%\fb-page-studio\                      │
│        .env · data\app.db · license · media           │
│  Cài đè Setup: GIỮ data/env (deleteAppData=false)     │
└───────────────────────────────────────────────────────┘
```

| Việc | Làm ở đâu |
|------|-----------|
| Sửa code / bug | DEV source |
| Build Setup | `npm run build:desktop:setup` |
| Ship GitHub | tag `vX.Y.Z` + `gh release` (có Setup + SHA) |
| Cấp license | `scripts/gen-license.mjs` / Admin menu |
| Data user | **AppData**, không phải folder cài |

---

## 4. Tính năng chính theo module

### 4.1 Connect / OAuth
- Multi Meta App (`app1`, `app2`, …)
- Redirect HTTPS qua **modelswiki.top** (relay)
- Connect mở browser: **Chrome Portable** = `ChromePortable.exe` + URL only (v1.2.72)
- Không ép `--user-data-dir` / Profile hệ thống (tránh logout FB + captcha)

### 4.2 Đăng bài
- **Direct Local:** tool mở, đợi `run_at` rồi `POST` Graph
- **Hẹn Facebook:** `scheduled_publish_time` trên Graph
- Caption pool dùng chung · anti-spam · quota Page/ngày
- Media local · random spacing

### 4.3 Rotation
- So-le App / Page · cửa sổ giờ · gap cùng page
- Matrix / plan / run-now

### 4.4 Xóa Fanpage (`delete-posts.html`)
- List multi-edge: `published_posts`, `feed`, `posts`, `videos`, `reels`, `photos`, `tagged`, `visitor_posts` (nếu quyền)
- Graph **batch DELETE ×50** · adaptive parallel · GLOBAL pause code #4
- Filter **từ ngày / đến hết ngày** (23:59:59) — không multi-pass xóa ngoài khoảng
- **Share của page** (`status_type=shared_story`) — live DELETE OK
- Avatar/cover: thử xóa (Meta thường #200 nếu không same-app)
- Báo cáo fail + CSV / TXT link

### 4.5 Group delete
- Graph Groups API hạn chế mạnh; path parse post ID / upload list

### 4.6 License · Update
- Key trial / commercial · machine bind
- Update check GitHub Releases · Setup in-place Program Files

---

## 5. Giới hạn Meta (quan trọng)

| Lỗi / tình huống | Ý nghĩa |
|------------------|---------|
| `(#200) App can only delete photos created by the same app` | Ảnh không do app upload |
| `(#200) This post wasn't created by the application` | Bài không do app này tạo |
| `Unsupported request - method type: delete` | Object không support DELETE |
| `visitor_posts` #200 | Thiếu quyền / App Review |
| Code **#4** Application request limit | Rate limit app — tool GLOBAL pause |
| Captcha / logout browser sau bulk | Meta security + (cũ) mở Chrome sai profile |

**Không hứa xóa sạch 100%** page có lịch sử đăng tay / app khác.

---

## 6. Lệnh DEV thường dùng

```powershell
cd C:\Users\NCpc\fb-page-poster
npm install
npm test                          # unit + static gates
npm run test:delete-live          # unit date + LIVE list/share delete (cần token AppData)
npm run build:desktop:setup       # NSIS Setup
npm run pack:dev                  # Tổng Hợp Tool\pack-dev
```

Ship (khi đã đồng ý):

```powershell
# build + prepare assets + tag + gh release
# Setup latest luôn:
# https://github.com/trumrename/fb-page-studio/releases/latest/download/FB-Page-Studio-Setup.exe
```

---

## 7. File docs liên quan

| File | Nội dung |
|------|----------|
| `DOC-INDEX.md` | Mục lục docs |
| `CHECK-BUG.md` | Checklist test trước ship |
| `TRANG-THAI-HIEN-TAI.md` | Snapshot version / path / gate |
| `DOWNLOAD.md` | Link tải cố định |
| `YEU-CAU-BAT-BUOC.md` | Rule bắt buộc (AGENTS) |
| `HUONG-DAN-OAUTH-RELAY.md` | Relay domain |
| `HUONG-DAN-MAY-MOI.md` | Máy khách mới |
| `HAI-TOOL-TACH-ROI.md` | SAFE Graph vs Session Ops |
| `LICENSE-KEYS.md` | License |
| `GITHUB.md` | Release GitHub |

---

## 8. Changelog gần (tóm)

| Ver | Điểm |
|-----|------|
| **1.2.72** | Chrome Portable: `ChromePortable.exe` + URL only |
| **1.2.71** | Không ép system User Data/Profile → bớt logout FB |
| **1.2.70** | Bulk delete không OOM/out app; tray giữ process |
| **1.2.69** | Live share delete + `test:delete-live` gate |
| **1.2.67–68** | Filter ngày end-of-day; branding checkbox an toàn |
| **1.2.60+** | Adaptive batch · GLOBAL #4 · list wipe multi-edge |

---

*Cập nhật: 2026-07-30 · phiên bản code **1.2.72***
