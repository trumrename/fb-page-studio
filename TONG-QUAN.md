# FB Page Studio — Tổng quan tool

**1 app desktop** quản lý nhiều tài khoản Facebook + nhiều fanpage, đăng bài / hẹn giờ qua **Graph API chính thức** (không cookie, không giả Chrome, không emulator).

| | |
|--|--|
| **Tên** | FB Page Studio |
| **Phiên bản** | **1.2.20** |
| **Máy DEV (gốc)** | `D:\fb-page-poster\` |
| **Gói KHÁCH** | `D:\fb-page-poster\pack-customer\` (+ ZIP `FB-Page-Studio-v1.2.20-Windows.zip`) |
| **Ghi chú DEV** | `D:\fb-page-poster\pack-dev\README-DEV.md` |
| **Admin cấp key** | `D:\fb-page-poster\Admin-Quan-Ly\MENU-ADMIN.bat` |
| **Lưu trữ bản cũ** | `D:\fb-page-poster\Luu-Tru-Ban-Cu\` |
| **GitHub** | https://github.com/trumrename/fb-page-studio |
| **Docs** | `TRANG-THAI-HIEN-TAI.md` · `TIEN-DO.md` · `CHECK-BUG.md` · `BAO-CAO-TEST.md` |

---

## Logic đăng hiện tại v1.2.20

- **Direct Local:** tool phải mở; task đầu đăng ngay, task sau chờ `run_at` trên máy rồi gọi đăng trực tiếp. Không gửi lịch hẹn cho Facebook.
- **Hẹn Facebook:** Facebook giữ bài và tự đăng theo giờ; tổng bài/Page/ngày bằng đúng tổng số bài của các dòng khung giờ.
- **Caption dùng chung:** các Page trỏ cùng Caption folder dùng một con trỏ chung; caption chỉ được note sau khi Facebook nhận đăng thành công và không được cấp lại trong cửa sổ anti-spam.
- **Thông báo:** tối đa 3 popup có nút đóng; toàn bộ OK/FAIL vẫn lưu trong bảng tiến trình và lịch sử.

### Bản đang dùng để check bug

- EXE live: `FB-Page-Studio-App\FB-Page-Studio-Desktop-v1.2.20.exe`
- ZIP khách: `pack-customer\FB-Page-Studio-v1.2.20-Windows.zip` (cũng có trong `release-assets\`)
- Gói khách sạch: `npm run pack:all` · gate: `npm run release:verify`
- Bản cũ: `Luu-Tru-Ban-Cu\` (không còn rải trong App folder)
- Test: **189/189 PASS** · License commercial Owner-Dev

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
| Đổ file cho khách | `npm run pack:all` → `pack-customer\` + ZIP Windows |
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

Trạng thái màn đăng được lưu trong SQLite: Page đã chọn, Page đang cấu hình, tab và lịch dùng lần cuối vẫn giữ sau reload/đóng mở. Cấu hình Page tự lưu và được flush trước khi chuyển màn hình.

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

### Setup domain OAuth nhiều máy
Trong màn **Connect & chọn Page**, nhập một domain HTTPS để tool tự cập nhật `APP_BASE_URL` và Redirect URI cho App 1/App 2, đồng thời đưa đúng lệnh Ngrok. Nhiều máy có thể đăng song song; một domain chỉ được một máy dùng tại thời điểm Connect/Reconnect Facebook.

### Chrome Profile OAuth
Chọn Chrome Profile đã đăng nhập Facebook ngay trong app. Tool mở một tab OAuth mới trong đúng profile đó, nên dùng lại session Facebook thay vì profile Chrome mặc định/trống.

---

## 4. Giao diện

| Màn | URL |
|-----|-----|
| Tổng quan + tiến trình | `/app.html` |
| Kết nối App/Profile/Page | `/index.html` |
| Chọn Page + cấu hình + chạy + lịch + kết quả | `/posting.html` (4 workspace riêng) |
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
| `TRANG-THAI-HIEN-TAI.md` | Bản đang check, hash, phần đã đạt và phần chưa test live |
| `TIEN-DO.md` | Đã làm / chưa làm |
| `CHECK-BUG.md` | Checklist test |
| `LICENSE-KEYS.md` | Cấp key |
| `pack-dev/README-DEV.md` | Máy dev |
| `pack-customer/README-KHACH.txt` | Máy khách |
| `AGENTS.md` | Quy tắc AI: hỏi trước khi GH |
