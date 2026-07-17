# FB Page Studio — Tổng quan tool

**1 app desktop** quản lý nhiều tài khoản Facebook + nhiều fanpage, đăng bài / hẹn giờ qua **Graph API chính thức** (không cookie, không giả Chrome, không emulator).

| | |
|--|--|
| **Tên** | FB Page Studio |
| **Phiên bản** | **1.2.0** |
| **Loại** | Desktop Windows (Electron) + server nội bộ |
| **GitHub** | https://github.com/trumrename/fb-page-studio |
| **Docs** | `SETUP.md` · `HUONG-DAN.md` · `GITHUB.md` · `TIEN-DO.md` · `CHECK-BUG.md` · `LICENSE-KEYS.md` |

---

## 1. Mục tiêu sản phẩm

| Làm được | Không làm |
|----------|-----------|
| Multi-account OAuth official | Auto-login / cookie developers.facebook.com |
| **Multi Meta App** (App1 + App2) | 1 nick = free spam vô hạn |
| List page, followers, +7 ngày | Bịa data admin/BM khi API không có |
| Đăng feed text / ảnh / video | Story đăng API (chỉ cờ flag) |
| Hẹn giờ FB + **Rotation so-le** | Spam đa luồng song song |
| Caption random `.txt`/`.csv` | Scrap UI Facebook |
| Anti-spam + báo cáo CSV/Excel | Vượt limit / né Meta |
| **License key** (trial / NV / thương mại) | DRM bất khả xâm phạm (desktop offline) |

---

## 2. Kiến trúc

```
┌─────────────────────────────────────────────┐
│  FB Page Studio Desktop (Electron + logo)   │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│  Express :3847                              │
│  OAuth · Pages · Publish · Jobs             │
│  Rotation · Multi Meta App · License        │
│  Anti-spam · Reports · Scheduler 60s        │
└──────────────────┬──────────────────────────┘
                   ▼
            Graph API (HTTPS)
```

- **1 process** · **1 DB** · nhiều account · nhiều page · gắn `meta_app_key`
- Đăng / hẹn giờ **tuần tự** (~350 ms giữa task)
- **1 Meta App Dev** (không page) có thể giữ nhiều App ID; nick page Connect riêng từng app

---

## 3. Module chức năng

### 3.1 Multi Meta App + Accounts
- Connect **App 1** / **App 2** (`/auth/facebook?app=app1|app2`)
- `.env`: `FB_APP_ID` + `FB_APP_ID_2` / secret / tên
- Account lưu `meta_app_key` + `meta_app_id` — login **nhận đúng app**
- Cùng nick FB có thể Connect cả 2 app (2 dòng account)

### 3.2 Pages & Insights
- Sync list `/me/accounts`, followers, +7d
- Export Excel/CSV
- App API usage %

### 3.3 Publish
- text / photo / video · media inbox → posted
- Caption random · config per page · interval / max ngày

### 3.4 Hẹn giờ + **Rotation so-le**
- Bulk active_times / fixed
- **Rotation** (`posting.html`):
  - Tự nhóm theo Meta App (App1 ↔ App2 so le)
  - Vòng: `bài# → pageIndex → adminIndex → group`
  - Cùng page: khung giờ + gap random + jitter
  - Nhóm ngắn skip; nhóm dài chạy tiếp
  - API: `/api/jobs/rotation/*`

### 3.5 Anti-spam (Recommended mặc định)
| Rule | Giá trị |
|------|---------|
| Global / giờ | ~12 |
| Global / ngày | ~40 |
| Page cooldown | ~90 phút |
| Bulk | ≤15 page · ≤40 slot |
| Media hash 1 lần đời | ON |
| Force ignore quota | OFF (production) |

### 3.6 Jobs & báo cáo
- Progress % · toast · CSV/Excel `data/exports/dang_bai_chi_tiet.*`

### 3.7 License key
- Trial 7 ngày (mặc định) · giới hạn account/page
- Key ký **Ed25519** (private key chỉ bạn giữ)
- Loại: `trial` · `employee` · `commercial` · `lifetime`
- Gắn máy optional (`machine_id`)
- UI: `/license.html`
- Vendor: `node scripts/gen-license.mjs …` → xem `LICENSE-KEYS.md`
- **Lưu ý:** desktop offline **không** chống crack 100%; key + trial + giới hạn = lớp thương mại / nội bộ

---

## 4. Giao diện

| Màn | URL |
|-----|-----|
| Vận hành | `/app.html` |
| Pages / Connect | `/index.html` |
| Publish + Rotation | `/posting.html` |
| Anti-spam | `/antispam.html` |
| **License** | `/license.html` |

---

## 5. Dữ liệu

```
.env
data/
  app.db
  license.json          # key đã kích hoạt (local)
  .first_run            # mốc trial
  rotation_settings.json
  media/inbox|posted|captions
  exports/
keys/                   # vendor only
  license-private.pem   # KHÔNG commit / không ship
  license-public.pem
  issued/               # key đã cấp
```

---

## 6. Bảo mật

- Token mã hóa local
- Không commit `.env` / `data/` / private key
- OAuth user login chuẩn
- License signed; public key trong app

---

## 7. Giới hạn kỹ thuật

| Hạng mục | Ghi chú |
|----------|---------|
| Story API | Chưa |
| Parallel publish | Không (cố ý) |
| App 2 | Cần `FB_APP_ID_2` trên Meta |
| Anti-crack tuyệt đối | Không khả thi offline 100% |

---

## 8. Stack

Electron · Node 18+ · Express · better-sqlite3 · Graph v21 · ExcelJS · electron-builder

---

## 9. Flow chuẩn

```
1. Meta App 1 (+ App 2) · .env · ngrok
2. Mở app · License (trial hoặc nhập key)
3. Connect App1 / App2 (nick giữ page)
4. Sync · inbox · captions · anti-spam Recommended
5. Rotation preview → hẹn giờ / đăng tuần tự
6. Xem CSV báo cáo
```

---

## 10. Gợi ý vận hành

| | |
|--|--|
| Page / nick | 2–3 |
| App / batch đăng | ~8–12 page |
| Meta App | 1 Dev cầm nhiều app; pool nick page tách theo app |
| 1 máy | 1–2 Meta App trong tool |

Chi tiết tiến độ: **`TIEN-DO.md`** · checklist bug: **`CHECK-BUG.md`**.
