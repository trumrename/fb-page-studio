# Báo cáo test toàn bộ tool — cập nhật 2026-07-20

## Hotfix v1.2.22 — Ngrok localhost/ERR_NGROK_314

- Nguyên nhân: `APP_BASE_URL=http://localhost:3847` bị lấy làm custom hostname `--url=https://localhost`.
- Đã sửa API từ chối `localhost`, `127.0.0.1`, `::1` và `.localhost` làm domain OAuth.
- Ngrok manager không còn spawn khi origin local; trả `needs_domain` với hướng dẫn nhập domain HTTPS công khai.
- Lỗi ERR_NGROK_314 cũng được phân loại thành `needs_domain`, không còn popup lỗi mơ hồ.
- Chọn Chrome hỗ trợ chọn nhiều thư mục/ổ trong Explorer, quét đệ quy nhiều ChromePortable và hiển thị đường dẫn đầy đủ cho từng profile.
- Profile được lưu cùng executable Chrome gần nhất, tránh mở nhầm bản Chrome khi các profile đều có tên `Default`.
- Test hồi quy: **218/218 PASS**; clean runtime 20 endpoint PASS.
- Build/pack/ZIP/release verify v1.2.22 PASS; EXE SHA-256 `2B6FFFB9352317C0A7320E72F1A8EA497BB9A44D71087D5F6D09087794B3A995`.

## Audit clean toàn dự án v1.2.21 — 2026-07-20

- 112 file source/config/doc ngoài build và archive đã được lập inventory.
- 58/58 file JavaScript/MJS/CJS đạt `node --check`; 5/5 inline script HTML compile thành công.
- Relative import và ID HTML đã đối chiếu, không phát hiện file import thiếu hoặc ID trùng thật.
- `npm test`: **209/209 PASS**, gồm clean runtime 20 endpoint và caption pool dùng chung.
- `npm audit`: **0 vulnerability**; `npm audit --omit=dev`: **0 vulnerability**.
- `git diff --check`: không có lỗi whitespace; chỉ có cảnh báo LF/CRLF của Windows.
- Đã thêm hồi quy cho route bulk, chế độ từng App của lịch Facebook, public Ngrok 403, quota ngày Việt Nam, UTC, resource pool, updater SHA-256, giới hạn API, report day và URL/attribute unsafe.
- Electron nâng lên 42.7.0, electron-builder 26.15.3, better-sqlite3 12.11.1; exceljs override uuid 11.1.1 để loại dependency vulnerability.
- Electron 43.1.1 ban đầu không có better-sqlite3 prebuilt và đòi Visual Studio C++; đã chuyển sang Electron 42.7.0 (ABI v146 có prebuilt chính thức) và thay `electron-rebuild -f` bằng script cài binary xác định, giúp build máy DEV sạch không cần Visual Studio.
- Build Electron 42.7.0, pack khách/dev và release gate đều PASS.
- EXE build, gói khách, gói dev, release-assets và thư mục App cùng SHA-256: `A8DE714F3B68A6D827084EBC7E87F33EABD67BBFA4115A51D799A2C93F48D662`.
- ZIP khách giải nén thật thành công: 8 file, EXE 97,050,136 byte; ZIP SHA-256 `3A29B9AA21B287F9ED11B5AE5704D530EEA104149B99C75BE5ED5B5BA64C4DF6`.

## Kiểm thử hồi quy v1.2.21 — quota, timezone và trạng thái

- `npm test`: **PASS 209/209**.
- Clean runtime: **PASS 20 endpoint** và database mới.
- `npm run release:verify`: **RELEASE VERIFIED v1.2.21**.
- EXE build, gói khách/dev, release-assets và thư mục App cùng SHA-256: `A8DE714F3B68A6D827084EBC7E87F33EABD67BBFA4115A51D799A2C93F48D662`.
- ZIP khách giải nén thành công, có 8 file và EXE đúng hash.
- Direct preview chỉ tạo số task còn lại trong quota Page.
- `posts_today` ngày cũ trả về 0 theo ngày Việt Nam.
- Workspace có `active_page_id` lệch sẽ tự đưa về Page đã tick.
- UTC `last_post_at` được parse có hậu tố `Z` trước khi kiểm tra interval.
- Retry schedule quá hạn được dời sang giờ tương lai.
- `schedule_overdue` được đưa lại vào đối soát.
- Resource snapshot được làm mới trong khi Direct Local chờ.

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
| Job đăng text 1 page | PASS (code/test; chưa chạy Facebook thật v1.2.21) |
| Job bulk 3 page text | PASS (sau fix) |
| Schedule dry-run | PASS |
| Reports CSV/Excel | PASS |
| Preferred hours / active times | PASS |
| Export pages CSV | PASS |
| Update check GitHub | PASS |

**Chưa thực hiện đăng Facebook thật bằng EXE v1.2.21** để tránh tạo bài ngoài ý muốn; các luồng đăng được kiểm tra bằng test/code và dry-run.

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
