# TIẾN ĐỘ / GHI NHỚ ĐÃ LÀM

> Cập nhật: **2026-07-19** · Code: **1.2.20**  
> **Gốc DEV:** `D:\fb-page-poster\`  
> **Gói KHÁCH:** `pack-customer\` + ZIP `FB-Page-Studio-v1.2.20-Windows.zip`  
> **Admin:** `Admin-Quan-Ly\` · **Lưu trữ cũ:** `Luu-Tru-Ban-Cu\`  
> **GitHub:** `trumrename/fb-page-studio`  
> **Trạng thái nhanh:** `TRANG-THAI-HIEN-TAI.md`

---

## Hai gói (quan trọng)

| | DEV (máy bạn) | KHÁCH |
|--|---------------|--------|
| Path | `D:\fb-page-poster\` + `pack-dev\` | `pack-customer\` |
| Có source? | Có | Không |
| Có private key? | Có (`keys/license-private.pem`) | **Không** |
| Có .exe? | Build ra `dist-desktop-oauth\` | Copy vào pack-customer khi sync |
| Cấp key? | Có | Chỉ **nhận** key / trial |

Sync gói khách + dev + ZIP:

```powershell
cd D:\fb-page-poster
npm run build:desktop
npm run pack:all
npm run release:asset
npm run release:verify
```

---

## Mốc v1.2.20 (gần nhất)

- [x] License commercial / recovery dual-data; encryption key mạnh
- [x] Direct Local vs Hẹn FB; retry task lỗi trên UI tiến trình
- [x] Active times fallback preferred/preset (Meta gỡ page_fans_online)
- [x] Ngrok token system import; domain_busy hướng dẫn dashboard
- [x] Dọn `Luu-Tru-Ban-Cu`; gói `Admin-Quan-Ly` cấp key
- [x] `pack:all` + ZIP máy khách + release:verify **PASS**
- [x] Test **189/189**

---

## Mốc đã hoàn thành

### A. Nền tảng (v1.0 → v1.1)
- [x] OAuth multi-account, page token mã hóa
- [x] Sync pages / followers / export
- [x] Publish text/photo/video · caption random · media inbox
- [x] Hẹn giờ FB bulk
- [x] Anti-spam preset
- [x] Jobs % + toast + CSV/Excel
- [x] Electron desktop + OAuth 2FA external

### B. Multi Meta App + Rotation (v1.2)
- [x] App1 / App2 env + OAuth `meta_app_key`
- [x] UI Connect + badge
- [x] Rotation so-le · khung giờ · gap · API + UI
- [x] Fix app2 không fallback app1
- [x] `scripts/test-requirements.mjs`

### C. License (v1.2)
- [x] Ed25519 · trial · employee/commercial/lifetime
- [x] UI `/license.html` · gate publish/connect
- [x] **Giữ key sau update** (`data/license.json` + backup)
- [x] `LICENSE-KEYS.md` · `gen-license.mjs`

### D. Auto-update (v1.2.x)
- [x] Banner + nút cập nhật · recheck 4h
- [x] Default GITHUB_REPO · khớp .exe
- [x] Update chỉ thay exe — không xóa data/license
- [ ] Upload .exe lên GH Release (khi bạn build + đồng ý)

### E. Tách gói DEV / KHÁCH (mới)
- [x] `pack-dev/README-DEV.md`
- [x] `pack-customer/` + README-KHACH + .env.example
- [x] `scripts/sync-customer-pack.mjs`
- [x] `AGENTS.md` — **hỏi trước khi push GH**
- [x] Cập nhật TONG-QUAN / TIEN-DO / CHECK-BUG

### F. UX v1.2.1
- [x] Chọn folder kho caption + kho ảnh/video (Windows dialog)
- [x] Tải CSV/Excel không rời app + nút quay về log
- [x] Job: Tạm dừng / Tiếp tục / Dừng
- [x] Connect mở Chrome ưu tiên (session login)
- [x] Portable update path + sqlite ABI fix

### G. Vận hành và báo cáo v1.2.2
- [x] Tách workspace rõ: Tổng quan · Kết nối · Cấu hình Page · Xoay vòng/Chạy · Tiến trình · Anti-spam · Báo cáo · License
- [x] Hai chế độ xoay vòng: theo từng App và hai App so le; tự xử lý khi App/Admin không đủ Page
- [x] Chạy ngay, lịch theo giờ Việt Nam, khoảng nghỉ Page và kiểm tra lịch quá khứ
- [x] Job có phần trăm, thông báo thành công/lỗi, trạng thái từng tác vụ và phục hồi theo dõi sau restart
- [x] Khóa thao tác theo Page và khóa chồng scheduler để tránh đăng trùng
- [x] Đối soát bài hẹn giờ Facebook thủ công + tự động mỗi 5 phút
- [x] Báo cáo Page theo App: CSV ngày + Excel cộng dồn mỗi ngày một sheet
- [x] Lịch sử đăng: CSV ngày + Excel cộng dồn, tự xuất 23:59 giờ Việt Nam
- [x] Theo dõi follower từng Page, tăng/giảm 1 · 3 · 7 · 30 ngày
- [x] Refresh follower trước báo cáo Page cuối ngày; ghi rõ Page thiếu quyền Facebook
- [x] Bộ kiểm thử tự động: **129/129 đạt** trước build phát hành

### H. Tài nguyên đăng v1.2.3
- [x] Media luôn chọn random và tránh các file nằm gần ba lần chọn gần nhất trong cùng kho
- [x] Caption chạy lần lượt hết vòng đầu; các vòng sau trộn thứ tự rồi tiếp tục xoay vòng
- [x] Áp dụng chung cho đăng trực tiếp, chạy ngay, rotation và hẹn giờ
- [x] Bỏ lựa chọn random/sequential gây hiểu nhầm trên giao diện Page
- [x] Bộ kiểm thử tự động: **133/133 đạt**
- [x] Tách con trỏ caption khỏi vòng loại bài; migration giữ đúng vị trí đang chạy
- [x] Chỉ ghi lịch sử media gần nhau sau khi Facebook nhận bài thành công
- [x] Số media khả dụng loại trừ hash đã dùng; bộ kiểm thử sau rà soát: **136/136 đạt**

### I. Setup domain OAuth v1.2.4
- [x] Nhập domain HTTPS ngay trong app, không cần sửa `.env` thủ công
- [x] Tự cập nhật `APP_BASE_URL` + `FB_REDIRECT_URI` cho App 1/App 2
- [x] Hiển thị/copy đúng lệnh Ngrok theo cổng của máy
- [x] Nhắc rõ nhiều máy đăng song song được; domain OAuth chỉ chiếm khi Connect Facebook

### J. Chrome Profile OAuth v1.2.5
- [x] Liệt kê profile Chrome có trên máy và lưu profile được chọn cho Connect Facebook
- [x] Mở OAuth bằng `--profile-directory`, dùng lại session Facebook của profile đã login
- [x] Không cố chiếm tab Chrome đang click (Chrome không cho app ngoài can thiệp tab đó)
- [x] Kiểm thử tự động: **140/140 đạt**

### K. Áp dụng profile không restart v1.2.6
- [x] Electron đọc lại lựa chọn Chrome Profile trước mỗi lần mở OAuth
- [x] Lưu profile xong bấm Connect ngay, không cần tắt/mở tool

### L. Direct updater có tiến trình v1.2.7
- [x] Tool tải EXE trực tiếp từ GitHub Release và hiển thị byte/% tải xuống
- [x] Electron chính thoát trước khi thay EXE; không để BAT/CMD lặp vì file còn bị khóa
- [x] BAT update chạy nền ẩn, giữ nguyên `.env`, `data` và license

### M. Explorer chọn ổ + kiểm thử môi trường sạch v1.2.18 — 2026-07-19
- [x] Loại bỏ FolderBrowserDialog kiểu cũ bị thu nhỏ.
- [x] Electron dùng hộp Explorer chuẩn của Windows qua preload/IPC; hiển thị This PC và đủ ổ C, D, E, F.
- [x] Media, Posted, Caption và ChromePortable dùng chung một bộ chọn thư mục chuẩn.
- [x] Browser/server fallback chuyển sang OpenFileDialog, không quay lại Browse For Folder.
- [x] Sửa database sạch thiếu scheduled_publish_time gây Internal Server Error.
- [x] Thêm YEU-CAU-BAT-BUOC.md và bắt buộc đọc từ AGENTS.md trước mỗi lần sửa/build.
- [x] Thêm kiểm tra hồi quy: hộp Explorer đầy đủ, cấm FolderBrowserDialog, database mới có cột lịch.
- [x] Kiểm thử tự động: **158/158 đạt**.
- [x] Test trực tiếp EXE v1.2.18 trong thư mục sạch: dashboard OK, không Internal Server Error, chọn Chrome/Media mở Explorer đầy đủ ổ đĩa.

### N. Lưu trạng thái + làm lại workspace đăng bài v1.2.19 — 2026-07-19
- [x] Thêm bảng SQLite `app_settings`; lựa chọn Page, Page đang mở, tab và điều khiển lịch cuối cùng không còn phụ thuộc checkbox DOM.
- [x] Đổi tab, tải lại trang và đóng/mở app vẫn giữ đúng Page đã chọn, bulk schedule và rotation draft.
- [x] Bấm dòng Page = chọn Page cho lần chạy + mở đúng cấu hình; có thanh tóm tắt Page ảnh hưởng luôn hiển thị.
- [x] Cấu hình Page tự lưu, flush trước khi đổi Page/tab/đóng app; kiểm thử chuyển Page ngay sau khi nhập vẫn không mất dữ liệu.
- [x] Tách giao diện đăng thành 4 workspace khác nhau: Chọn & cấu hình · Chạy ngay/Rotation · Hẹn giờ hàng loạt · Kết quả/lịch sử.
- [x] Menu/hash/topbar đồng bộ; bấm mục nào hiển thị đúng tên và đúng panel chức năng đó.
- [x] Rotation và hẹn lịch luôn dùng đúng Page chọn ở bước 1; không âm thầm rơi về toàn bộ Page.
- [x] Sửa DB máy mới thiếu `active_hours_json`, `active_hours_at`, `preferred_hours_json` làm `/api/posting/pages` lỗi 500 và không chọn được Page.
- [x] Sửa đường dẫn `.env` lần đầu: `FB_USER_DIR/FB_EXE_DIR` luôn là nơi lưu, không nhặt nhầm `.env` thư mục source/bundle.
- [x] Test giao diện thật: chọn Page 2 → đổi số bài → sang tab lịch → reload → giữ đúng Page, tab, lịch và config; chuyển Page tức thì vẫn lưu.
- [x] Clean runtime: 20 endpoint + DB mới + `.env` mới + workspace persistence PASS.
- [x] Bộ kiểm thử tự động: **174/174 đạt**.
- [x] EXE đóng gói v1.2.19 trong thư mục Temp chỉ có EXE: nhận đúng packaged/version, tạo `data` và `.env` cạnh EXE, không sửa `.env` DEV.
- [x] Release verify: version nhúng, tên asset, hash build/gói khách/sidecar và loại trừ secret đều PASS.
- [x] ZIP Windows v1.2.19 tạo từ gói khách và giải nén thử PASS: 7 file, EXE 79,711,112 byte, hash khớp build.

### O. Direct Local + caption dùng chung + popup v1.2.20 — 2026-07-19
- [x] Sửa lỗi Direct Local: mọi task đều là `post`; tool giữ `run_at`, chờ tại máy rồi gọi đăng trực tiếp, không còn đổi task sau thành Facebook schedule.
- [x] Direct Local có loại bài, số bài và gap cùng Page riêng; không đọc ngầm khung giờ/số ngày của Hẹn Facebook.
- [x] Hẹn Facebook theo khung giờ lấy tổng bài duy nhất từ tổng các dòng; dòng sai hoặc 0 bài bị chặn rõ.
- [x] Nhiều Page dùng chung kho caption dùng một con trỏ SQLite nguyên tử; không còn mỗi Page bắt đầu lại caption đầu kho.
- [x] Caption đăng thành công được note vào anti-spam; số còn lại live = tổng kho trừ caption đã dùng trong cửa sổ chống trùng.
- [x] Popup Vận hành tối đa 3, có nút đóng, tự hết hạn, gom cập nhật dồn và không phát lại lịch sử job cũ.
- [x] Test tĩnh/chức năng: 186/186; test caption pool và clean runtime đạt.
- [x] Test giao diện local: Direct hiện riêng, khối Hẹn Facebook thu gọn; tạo 5 popup liên tiếp chỉ giữ 3 popup có nút đóng.
- [x] Build/pack/release verify v1.2.20 đạt; EXE build cuối nhúng đúng version và hash `d4d8bee7...34fbbf`.
- [x] ZIP khách giải nén thử đạt: 8 mục top-level, có EXE versioned + SHA-256 sidecar, hash EXE khớp build.
- [x] Runtime thật trong `FB-Page-Studio-App` đã được mở: log/API xác nhận packaged v1.2.20; scheduler hiện `enabled_pages=0`, không có lỗi.
- [x] Đồng bộ `FB-Page-Studio-App\VERSION.txt` lên v1.2.20 và chuyển 4 EXE cũ vào `_old-versions` để tránh mở nhầm.
- [x] Phát hiện release asset/ZIP cũ cùng version nhưng khác hash sau lần build cuối; đã chạy lại pack → release asset → ZIP → release verify và đồng bộ hash mới.

---

## Chưa làm / chờ bạn

| Hạng mục | Ai |
|----------|-----|
| `FB_APP_ID_2` nếu dùng App 2 | Bạn |
| Build + sync pack-customer có EXE | Hoàn thành v1.2.20 |
| Push GH / Release có asset | **Chờ user xác nhận sau khi xem kết quả** |
| Online revoke license | Sau |

---

## Quy trình mỗi lần fix / build (song song 2 gói)

1. Sửa trên **gốc** `D:\fb-page-poster`  
2. Test (`test-requirements` + `CHECK-BUG.md`)  
3. Build desktop (nếu cần ship)  
4. `node scripts/sync-customer-pack.mjs` → cập nhật **pack-customer**  
5. Cập nhật dòng ngày trong TIEN-DO / CHECK-BUG nếu đổi lớn  
6. **Hỏi bạn:** có cập nhật GitHub không? → **Không tự push**

---

## Lệnh nhanh

```powershell
cd D:\fb-page-poster
npm start
npm test
node scripts/gen-license.mjs --type lifetime --holder "KH" --lifetime
npm run build:desktop
node scripts/sync-customer-pack.mjs
```
