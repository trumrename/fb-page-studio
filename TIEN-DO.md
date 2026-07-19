# TIẾN ĐỘ / GHI NHỚ ĐÃ LÀM

> Cập nhật: **2026-07-19** · Code: **1.2.7**
> **Gốc DEV:** `D:\fb-page-poster\`  
> **Gói KHÁCH:** `D:\fb-page-poster\pack-customer\`  
> **GitHub:** `trumrename/fb-page-studio` — **push chỉ khi user OK**

---

## Hai gói (quan trọng)

| | DEV (máy bạn) | KHÁCH |
|--|---------------|--------|
| Path | `D:\fb-page-poster\` + `pack-dev\` | `pack-customer\` |
| Có source? | Có | Không |
| Có private key? | Có (`keys/license-private.pem`) | **Không** |
| Có .exe? | Build ra `dist-desktop-oauth\` | Copy vào pack-customer khi sync |
| Cấp key? | Có | Chỉ **nhận** key / trial |

Sync gói khách:

```powershell
cd D:\fb-page-poster
npm run build:desktop
node scripts/sync-customer-pack.mjs
```

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

---

## Chưa làm / chờ bạn

| Hạng mục | Ai |
|----------|-----|
| `FB_APP_ID_2` nếu dùng App 2 | Bạn |
| Build + sync pack-customer có .exe | Đang thực hiện cho v1.2.2 |
| Push GH / Release có asset | Đã được user cho phép cho v1.2.2 |
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
