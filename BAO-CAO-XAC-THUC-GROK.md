# Báo cáo xác thực Grok — FB Page Studio

| | |
|--|--|
| **Công cụ** | Grok (xAI) — kiểm tra / xác thực codebase |
| **Ngày** | 2026-07-20 |
| **Phạm vi** | Code, test, gói khách/dev, EXE live, GitHub Release, bảo mật Ngrok Host |
| **Repo** | `D:\fb-page-poster` · GitHub `trumrename/fb-page-studio` |

---

## 0. Cam kết trung thực

Báo cáo này **không** tuyên bố:

- “Đã đọc và chứng minh từng dòng code.”
- “Tool 100% không còn bug / không thể bị tấn công.”
- “EXE đang chạy = bản test vừa PASS = GitHub Latest cùng một artifact.”

Báo cáo **có** tuyên bố (kèm bằng chứng tại thời điểm kiểm tra):

- Phần **đo được** bằng test/static/probe: pass hay fail.
- Lệch phiên bản giữa các nơi.
- Lỗ hổng / rủi ro đã **tái hiện** được.

**Quy mô code (ước lượng):**

| Khu vực | Dòng (xấp xỉ) |
|---------|----------------|
| `src/` | ~10 800 |
| `public/` | ~4 400 |
| Script test `scripts/test-*.mjs` | ~960 |

Xác thực = **test tự động + static gate + probe live + rà soát có chủ đích** — không phải formal proof line-by-line.

---

## 1. Kết luận tổng

| Tiêu chí | Verdict |
|----------|---------|
| Core logic đo được (test 198/198) | **PASS** |
| Gói khách không chứa secret | **PASS** |
| GitHub Release v1.2.20 có EXE + ZIP | **PASS** |
| Một version thống nhất (GH / EXE live / source / pack) | **FAIL** |
| Bảo mật public Host trên binary đang dùng | **FAIL** |
| “Clean mọi thứ / mọi dòng đã xác thực” | **FAIL** |

### Verdict tổng (thành thật)

**KHÔNG CLEAN HOÀN TOÀN.**

- **Core tool + test + gói khách (secret)** ở mức tốt, đo được.
- **Ship / runtime / source** chưa đồng bộ phiên bản.
- **Binary đang chạy (1.2.20)** và **asar build 1.2.21 trên đĩa** (tại lúc check) **chưa** đóng gói middleware chặn public Host cho API local; **source disk uncommitted** thì đã có guard.

---

## 2. Bằng chứng kiểm tra

### 2.1 Lệnh & kết quả

| Lệnh / hành động | Kết quả |
|------------------|---------|
| `npm test` | **198/198 PASS** (package version lúc chạy: **1.2.21**) |
| `npm run release:verify` | **RELEASE VERIFIED: v1.2.21** |
| Live `GET /api/health` | OK · `version: "1.2.20"` · packaged |
| Live license | `commercial` · Owner-Dev · max_accounts/pages = 0 (unlimited) |
| Live ngrok | `token_configured: true` · status **`domain_busy`** · domain `qgroup.ngrok.app` |
| Live update check | current **1.2.20** · latest GH **1.2.20** · `has_update: false` |
| GitHub latest release | tag **v1.2.20** · assets: EXE + ZIP + 2× sha256 |
| pack-customer forbidden | `.env` / `data` / `src` / `keys` = **không tồn tại** |

### 2.2 Probe bảo mật Host (quan trọng)

Trên **EXE live 1.2.20** (`http://127.0.0.1:3847`):

| Request | Kết quả quan sát |
|---------|------------------|
| `Host: qgroup.ngrok.app` + `GET /api/health` | **HTTP 200** + JSON health (API **không** bị chặn) |
| `Host` local + `GET /api/health` | HTTP 200 |
| Local các route chính (`/api/version`, `/api/accounts`, `/api/jobs`, `/api/posting/pages`, `/api/license/status`, `/auth/apps`, …) | **200** |

**Ý nghĩa:** Khi Ngrok tunnel **đang online**, request public tới domain với `Host` public có thể chạm **toàn bộ API local** (không chỉ OAuth callback), trừ khi binary có middleware chặn.

**Source disk (working tree, uncommitted):** `src/server.js` có middleware:

- `isLocalHost` hoặc `GET /auth/facebook/callback` → cho qua  
- còn lại Host public → **403**

**Asar** `dist-desktop-oauth/win-unpacked/resources/app.asar` (package **1.2.21** lúc check):

- `isFacebookCallback` / host guard **không** có trong `src/server.js` trong asar  
→ build 1.2.21 local **chưa** khớp guard trên disk (hoặc build trước khi thêm guard).

**Lưu ý test:** `scripts/test-clean-runtime.mjs` chạy server từ **source** (`node`), không chạy asar/EXE → có thể **PASS** host guard trong test trong khi binary ship vẫn hở.

### 2.3 Lệch phiên bản (snapshot)

| Nơi | Version |
|-----|---------|
| GitHub Release Latest | **1.2.20** |
| EXE đang chạy `FB-Page-Studio-App\…v1.2.20.exe` | **1.2.20** |
| `package.json` working tree | **1.2.21** (uncommitted) |
| pack-customer / dist build local | **1.2.21** EXE/ZIP có trên đĩa |
| Commit `main` đã push (lúc ship 1.2.20) | `ef31d83` · message v1.2.20 |

**Hệ quả:** “Test PASS 1.2.21” ≠ “khách đang tải 1.2.21” ≠ “app trên máy admin đang chạy 1.2.21”.

---

## 3. Phạm vi đã rà (có chủ đích)

### 3.1 Ổn / đúng hướng

- Graph API chính thức (OAuth + page token); không cookie-scrape Facebook.
- Job đăng tuần tự; page operation lock; không parallel post trong runner.
- Direct Local vs hẹn giờ Facebook tách kind/route.
- License Ed25519; private key không trong gói khách.
- pack-customer: README, HUONG-DAN, VERSION, MANIFEST, sha256, ZIP (local).
- Admin-Quan-Ly: menu cấp key (script + bat).
- Luu-Tru-Ban-Cu: bản EXE/build cũ đã gom (không nằm rải App folder).

### 3.2 Đã ship / đã làm trong session trước (tham chiếu)

- Retry task lỗi (`retry-failed` + UI).
- Active times: preferred / preset VN (Meta deprecate `page_fans_online`).
- License commercial recovery dual-data.
- Ngrok token import hệ thống; domain busy có message dashboard.
- Gói ZIP khách + GH Release v1.2.20.

### 3.3 Chưa chứng minh end-to-end trong lần check này

- Full Direct Local nhiều page đăng thật.
- Multi Meta App so le live (App 2 chưa cấu hình).
- OAuth Connect end-to-end qua Ngrok (đang `domain_busy`).
- Update in-place 1.2.20 → 1.2.21 trên máy khách thật.

---

## 4. Rủi ro còn lại (desktop app — nói thẳng)

| Rủi ro | Mức | Ghi chú |
|--------|-----|---------|
| Public Host → API khi Ngrok up (binary thiếu guard) | **Cao** khi tunnel online | Đã probe 200 trên live 1.2.20 |
| Token FB mã hóa trong SQLite | Trung bình | Key mã hóa trong `.env` cạnh EXE |
| License offline | Thấp–TB | Chống copy nghiệp dư, không chống crack 100% |
| Ngrok token / Meta secret trong `.env` | TB | Bảo vệ folder máy |
| `domain_busy` Ngrok | Vận hành | Không phải bug code Graph |
| Working tree dirty 1.2.21 | Vận hành / ship | Dễ nhầm bản |

---

## 5. Test PASS nghĩa là gì

### Có nghĩa

- Các requirement đã map trong `test-requirements.mjs` khớp code source hiện tại.
- Rotation / caption / clean DB / workspace restore không gãy trong kịch bản test.
- Artifact **1.2.21 local** thỏa `release:verify` (hash, secret pack, một số cờ updater/ngrok trong asar).

### Không nghĩa

- Mọi nhánh Graph/Meta production đã live.
- EXE GitHub = working tree.
- EXE đang chạy = bản vừa `npm test`.
- Không còn bug ngoài phạm vi đo.

---

## 6. Checklist “để thực sự clean” (gợi ý)

1. Chốt **một** version (1.2.21 hoặc quay 1.2.20).
2. Đảm bảo host guard trong `src/server.js` **có trong asar** sau `npm run build:desktop` (extract kiểm tra `isFacebookCallback`).
3. `npm test && npm run release:verify`.
4. Probe sau rebuild: `Host: qgroup.ngrok.app` + `/api/health` → **phải 403**.
5. Commit + tag + GH Release **một** bản; thay EXE trong `FB-Page-Studio-App`.
6. Free Ngrok domain → smoke Connect 1 lần.
7. (Tuỳ chọn) Live test Direct Local + retry fail 1 job nhỏ.

---

## 7. Cấu trúc thư mục liên quan (sau dọn)

```
fb-page-poster/
├── FB-Page-Studio-App/     # EXE + data chạy thật
├── pack-customer/          # gói / ZIP khách
├── pack-dev/               # gói dev
├── Admin-Quan-Ly/          # cấp key
├── Luu-Tru-Ban-Cu/         # bản cũ
├── release-assets/         # staging GH (gitignore)
├── src/ public/ electron/
└── BAO-CAO-XAC-THUC-GROK.md  # file này
```

---

## 8. Tóm tắt một câu

**Tool cốt lõi và test tự động ở trạng thái tốt; gói khách không lộ secret; nhưng hệ thống chưa “clean tuyệt đối” vì lệch version (1.2.20 runtime/GH vs 1.2.21 tree/pack) và binary hiện tại vẫn cho phép API qua public Host khi Ngrok online — guard chỉ chắc trên source disk chưa ship.**

---

*File do Grok tạo sau phiên xác thực. Cập nhật lại sau khi rebuild/ship nếu muốn snapshot mới.*
