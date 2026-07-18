# FB Page Studio — Tổng quan tool

**1 app desktop** quản lý nhiều tài khoản Facebook + nhiều fanpage, đăng bài / hẹn giờ qua **Graph API chính thức** (không cookie, không giả Chrome, không emulator).

| | |
|--|--|
| **Tên** | FB Page Studio |
| **Phiên bản** | **1.2.2** |
| **Máy DEV (gốc)** | `D:\fb-page-poster\` |
| **Gói KHÁCH** | `D:\fb-page-poster\pack-customer\` |
| **Ghi chú DEV** | `D:\fb-page-poster\pack-dev\README-DEV.md` |
| **GitHub** | https://github.com/trumrename/fb-page-studio |
| **Docs** | `TIEN-DO.md` · `CHECK-BUG.md` · `LICENSE-KEYS.md` · `GITHUB.md` · `AGENTS.md` |

---

## 0. Hai nơi lưu — đừng nhầm

```
┌─────────────────────────────────────────────────────────┐
│  MÁY BẠN (DEV) — file gốc                               │
│  D:\fb-page-poster\                                     │
│    src\ public\ electron\  … source                     │
│    keys\license-private.pem  ← cấp key, KHÔNG gửi khách │
│    .env  data\  … dev                                    │
│    pack-dev\README-DEV.md                                │
│    pack-customer\  ← sau build, zip gửi khách            │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  MÁY KHÁCH — chỉ nhận gói pack-customer                 │
│    FB-Page-Studio-Desktop.exe                           │
│    .env (tự điền từ .env.example)                       │
│    data\ (tự tạo: license.json, db, media)              │
│  KHÔNG: source, private key, node_modules               │
└─────────────────────────────────────────────────────────┘
```

| Việc | Làm ở đâu |
|------|-----------|
| Sửa bug / thêm tính năng | `D:\fb-page-poster\` (gốc) |
| Build exe | `npm run build:desktop` trên gốc |
| Đổ file cho khách | `node scripts/sync-customer-pack.mjs` → `pack-customer\` |
| Cấp license key | Máy DEV · `scripts/gen-license.mjs` |
| Push GitHub | **Chỉ khi bạn đồng ý** (xem `AGENTS.md`) |

---

## 1. Mục tiêu sản phẩm

| Làm được | Không làm |
|----------|-----------|
| Multi-account OAuth official | Cookie / auto-login dev.facebook |
| Multi Meta App (App1 + App2) | Spam song song đa luồng |
| Publish + hẹn giờ Graph | Story API đầy đủ |
| Rotation so-le app/page | Vượt limit Meta |
| Anti-spam + CSV/Excel | |
| License trial / NV / TM / lifetime | DRM 100% chống crack |
| Auto-update từ GitHub Release | Xóa license khi update |

---

## 2. Kiến trúc

```
Desktop (Electron) → Express :3847 → Graph API
  OAuth multi-app · Publish · Jobs sequential
  Rotation · Anti-spam · License · Auto-update
```

- Đăng **tuần tự** (~350 ms/task)  
- License: `data/license.json` — **giữ sau update** (vĩnh viễn hoặc còn hạn)  
- Update: chỉ thay `.exe`

---

## 3. Module chính

### Accounts / Multi Meta App
Connect `?app=app1|app2` · `meta_app_key` trên account · badge UI  

### Publish & Schedule  
text/photo/video · caption random · bulk hẹn giờ · **Rotation so-le**  

### Anti-spam  
Recommended: ~12/h · ~40/day · bulk ≤15 page · media 1 lần  

### License  
Trial 7 ngày · key Ed25519 · UI `/license.html` · private key chỉ DEV  

### Auto-update  
Banner + nút **Cập nhật ngay** · check mỗi 4h · cần Release có `.exe`  

### Vận hành và theo dõi
Giao diện tách rõ **Tổng quan → Kết nối → Cấu hình Page → Xoay vòng/Chạy → Tiến trình → Anti-spam → Báo cáo → License**. Job chạy tuần tự, có phần trăm, trạng thái từng tác vụ, thông báo thành công/lỗi và lưu trạng thái để tiếp tục theo dõi sau khi mở lại app.

### Báo cáo ngày và follower
- Thông tin Page tách theo App, ghi rõ App · Admin/Profile · Page; CSV theo ngày và Excel cộng dồn, mỗi ngày một sheet.
- Lịch sử đăng xuất CSV theo ngày và Excel cộng dồn; tự động chốt lúc **23:59 giờ Việt Nam**.
- Lưu follower từng Page theo ngày và hiển thị tăng/giảm **1 · 3 · 7 · 30 ngày**. Ngày đầu chưa đủ mốc sẽ ghi rõ chưa đủ dữ liệu.
- File nằm tại `FB-Page-Studio-App\data\exports\daily` trên bản đang dùng.

### Đồng bộ bài hẹn giờ Facebook
Bài hẹn giờ được đối soát thủ công hoặc tự động mỗi 5 phút. Khi Facebook xác nhận đã đăng, lịch sử chuyển từ `scheduled` sang `published`; thời gian quá khứ không được coi là một lịch hẹn mới hợp lệ.

---

## 4. Giao diện

| Màn | URL |
|-----|-----|
| Tổng quan + tiến trình | `/app.html` |
| Kết nối App/Profile/Page | `/index.html` |
| Cấu hình Page + xoay vòng/chạy | `/posting.html` |
| Anti-spam | `/antispam.html` |
| License | `/license.html` |

---

## 5. Flow DEV → KHÁCH

```
1. Code/fix trên D:\fb-page-poster
2. node scripts/test-requirements.mjs + CHECK-BUG.md
3. npm run build:desktop
4. node scripts/sync-customer-pack.mjs
5. Zip pack-customer → gửi khách + (tuỳ) cấp key
6. Hỏi bạn: có push GH / upload Release không?
```

---

## 6. Stack

Electron · Node 18+ · Express · better-sqlite3 · Graph v21 · ExcelJS  

---

## 7. Liên kết docs

| File | Nội dung |
|------|----------|
| `TIEN-DO.md` | Đã làm / chưa làm |
| `CHECK-BUG.md` | Checklist test |
| `LICENSE-KEYS.md` | Cấp key |
| `pack-dev/README-DEV.md` | Máy dev |
| `pack-customer/README-KHACH.txt` | Máy khách |
| `AGENTS.md` | Quy tắc AI: hỏi trước khi GH |
