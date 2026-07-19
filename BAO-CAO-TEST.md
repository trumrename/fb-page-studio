# Báo cáo test toàn bộ tool — cập nhật 2026-07-19

Workspace: `D:\fb-page-poster`  
Server test: Node `src/server.js` port 3847

Trạng thái vận hành ngắn gọn, file EXE/ZIP và các mục chưa test thật được tổng hợp tại `TRANG-THAI-HIEN-TAI.md`.

## Kết quả tổng

| Nhóm | Kết quả |
|------|---------|
| UI / static | PASS |
| Core API (accounts/pages/stats) | PASS |
| OAuth helper (external + 2FA tip) | PASS |
| Posting config | PASS |
| Anti-spam | PASS |
| Captions pool | PASS |
| Job đăng text 1 page | PASS (live FB) |
| Job bulk 3 page text | PASS (sau fix) |
| Schedule dry-run | PASS |
| Reports CSV/Excel | PASS |
| Preferred hours / active times | PASS |
| Export pages CSV | PASS |
| Update check GitHub | PASS |

**Live post OK** trên Facebook (text feed).

---

## Bug đã tìm & sửa trong phiên test

1. **Caption random retry** — retry vẫn random trúng caption trùng → sửa `pickCaption(..., exclude)` + sequential retry  
2. **Backoff Graph sai** — lỗi local (hết caption) bị coi là Graph fail → khóa cả app ~phút → chỉ `noteGraphFailure` khi lỗi Graph thật  
3. **Clamp config** — max/interval khi save áp anti-spam floor  
4. **UI Đăng ngay** — tách rõ khối xanh vs hẹn giờ vàng  
5. **OAuth 2FA** — external browser, bỏ rerequest, scope gọn  

---

## Lưu ý vận hành (không phải bug)

| Hiện tượng | Ý nghĩa |
|------------|---------|
| Caption trùng 48h | Cần kho caption **lớn** khi đăng nhiều page liên tiếp |
| Force ignore quota | Bị khóa khi `allow_ignore_quota=OFF` (đúng) |
| Desktop exe | Cần rebuild sau sửa code; chạy `npm run desktop` hoặc package lại |
| better-sqlite3 | `npm rebuild` cho Node; `@electron/rebuild` cho Desktop |

---

## Kiểm thử hồi quy v1.2.18 — 2026-07-19

| Hạng mục | Kết quả |
|----------|---------|
| npm test | PASS 158/158 |
| Syntax main/preload/folder picker | PASS |
| Database hoàn toàn mới | PASS, có scheduled_publish_time |
| EXE nhúng version 1.2.18 | PASS |
| Preload bridge chọn thư mục | PASS, trạng thái function |
| Chọn thư mục ChromePortable | PASS, Explorer đầy đủ |
| Chọn ổ Media | PASS, Explorer đầy đủ |
| Danh sách ổ trong This PC | PASS: C, D, E, F |
| Internal Server Error trên DB sạch | Đã sửa, không tái hiện |
| Release verify + hash | PASS |

Không nhập token thật, không chọn/lưu thư mục thật và không dùng dữ liệu Facebook thật trong bài test môi trường sạch.

## Kiểm thử hồi quy v1.2.19 — lưu trạng thái và workspace đăng

| Hạng mục | Kết quả |
|----------|---------|
| Syntax toàn bộ phần mới | PASS |
| SQLite `app_settings` | PASS |
| DB sạch có active/preferred hours | PASS |
| API lưu/đọc Page selection + tab + bulk/rotation | PASS |
| Clean runtime 20 endpoint | PASS |
| npm test | PASS 174/174 |
| `.env` lần đầu nằm đúng `FB_USER_DIR/FB_EXE_DIR` | PASS |
| Chọn Page → đổi tab → reload | PASS, giữ đúng Page |
| Sửa số bài/Page → đổi Page ngay | PASS, tự lưu trước khi chuyển |
| Bulk mode/count → reload | PASS, giữ đúng giá trị |
| Menu trái/hash/topbar | PASS, mở đúng workspace |
| Rotation dùng Page đã chọn | PASS, không tự chạy toàn bộ Page |
| EXE packaged chỉ có một file trong Temp | PASS, v1.2.19 |
| EXE lần đầu tạo `.env/data` cạnh chính nó | PASS |
| EXE test không sửa `.env` DEV | PASS, hash trước/sau giữ nguyên |
| Release verify version/hash/secret gate | PASS |
| ZIP Windows giải nén thử | PASS, 7 file |
| EXE trong ZIP khớp hash build | PASS |

Lỗi thật được phát hiện trong test giao diện: DB mới thiếu `preferred_hours_json` làm `/api/posting/pages` trả HTTP 500, danh sách Page đứng ở Loading và không thể chọn. Đã bổ sung đầy đủ `active_hours_json`, `active_hours_at`, `preferred_hours_json` ngay trong schema tạo mới và thêm kiểm tra hồi quy.

## Kiểm thử hồi quy v1.2.20 — Direct Local, caption và popup

| Hạng mục | Kết quả |
|----------|---------|
| Syntax JS nguồn + inline JS HTML | PASS |
| Direct route chỉ tạo `kind: post` | PASS |
| Direct task có `run_at`, không có `scheduled_publish_time` | PASS |
| Job runner chờ tại máy rồi gọi `runOnePost` | PASS |
| Direct UI có loại bài/số bài/gap riêng | PASS |
| Direct request không đọc rotWindows/rotMode/rotDays | PASS |
| Tổng bài Hẹn Facebook = tổng các dòng khung | PASS |
| Khung giờ 0 bài/sai định dạng bị HTTP 400 | PASS |
| Caption folder dùng chung có con trỏ nguyên tử | PASS, slot 7 → 8 → 9 |
| Note caption sau thành công | PASS, còn 3 → 2 |
| Clean runtime DB mới + Direct preview | PASS, 20 endpoint |
| Bộ kiểm thử yêu cầu | PASS 186/186 |
| Popup tạo liên tiếp | PASS, tối đa 3 popup và 3 nút đóng |
| Direct/Hẹn Facebook tách trực quan | PASS, phần Hẹn Facebook mặc định thu gọn |
| Build + release verify v1.2.20 | PASS |
| ZIP khách giải nén + đối chiếu EXE/SHA | PASS, 8 mục top-level |
| Runtime EXE tại `FB-Page-Studio-App` | PASS, `/api/meta` + `/api/version` = 1.2.20, packaged=true |
| Scheduler khi kiểm tra runtime | PASS an toàn, 0 Page enabled, không có last_error |
| Metadata thư mục App | PASS, `VERSION.txt` = 1.2.20 |
| EXE cũ | Đã chuyển v1.2.16–v1.2.19 vào `_old-versions`, không xóa |
| Asset cũ cùng version sau build lại | Đã phát hiện hash lệch, đồng bộ lại toàn bộ theo EXE `D4D8BEE7...34FBBF` và verify PASS |

Chưa gọi đăng Facebook thật trong test v1.2.20 để tránh tạo thêm bài ngoài ý muốn. Runtime hiện tại chỉ được kiểm tra bằng API đọc; không bật Page scheduler và không tạo job mới. Luồng Graph trực tiếp được giữ nguyên ở `runOnePost`; bài kiểm thử xác nhận route Direct không còn đi qua `scheduleOnePost`.

---

## Cách chạy sau test

```powershell
cd D:\fb-page-poster
npm start
# hoặc
npm run desktop
```

App console: http://127.0.0.1:3847/app.html  
Desktop: `FB-Page-Studio-App` / `dist-desktop-oauth` (nếu đã build)
