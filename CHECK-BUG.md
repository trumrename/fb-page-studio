# CHECK-BUG — Checklist kiểm thử FB Page Studio

> Trước mỗi ship / release. Đánh `[x]` khi OK.  
> **Phiên bản code:** 1.2.20
> **Gốc DEV:** `D:\fb-page-poster\`  
> **Gói KHÁCH:** `D:\fb-page-poster\pack-customer\`

## Trạng thái baseline v1.2.20

- [x] `npm test`: **189/189 PASS**
- [x] Clean runtime: **20 endpoint PASS**
- [x] Build + pack:all + `release:verify`: **PASS**
- [x] ZIP khách `FB-Page-Studio-v1.2.20-Windows.zip` + SHA: **PASS**
- [x] pack-customer không secret (.env/data/src/private key)
- [x] pack-dev đồng bộ EXE + README
- [x] UI Direct/Hẹn Facebook tách riêng; retry lỗi job: **PASS (code+API)**
- [x] Runtime App: v1.2.20 packaged, license commercial
- [x] Bản cũ gom `Luu-Tru-Ban-Cu\`
- [ ] Hai App thật so le: **chờ cấu hình App 2**
- [ ] Update từ GitHub v1.2.20: **sau release**

Xem `TRANG-THAI-HIEN-TAI.md`.

---

## 0. Phân biệt 2 gói

- [ ] Fix/build làm trên **DEV gốc**, không sửa tay lung tung chỉ trong pack-customer  
- [ ] Sau build đã chạy `node scripts/sync-customer-pack.mjs`  
- [ ] `pack-customer` **không** chứa: `license-private.pem`, `.env` secret, `data/app.db` token, folder `src/`  
- [ ] `pack-dev/README-DEV.md` và `pack-customer/README-KHACH.txt` còn đúng  

---

## 1. Tự động

```powershell
cd D:\fb-page-poster
npm test
```

- [ ] ALL CHECKS PASSED  

---

## 2. Khởi động (DEV)

- [ ] `npm start` / Desktop exe không black screen  
- [ ] `/api/meta` có `version` + `license`  
- [ ] Log `[license]` / `[update]` không lỗi lạ  

---

## 3. License

- [ ] `/license.html` hiện trial hoặc key  
- [ ] Key vĩnh viễn / còn hạn → active  
- [ ] Key hết hạn → chặn đăng  
- [ ] **Giả lập update:** key trong `data/license.json` vẫn còn sau restart  
- [ ] Machine ID hiển thị  

---

## 4. Multi Meta App / OAuth

- [ ] Connect App 1 → badge App 1  
- [ ] App 2 (nếu có env) Connect đúng  
- [ ] App 2 chưa config → lỗi, không login nhầm App 1  
- [ ] 2FA external browser OK  
- [ ] Lưu domain HTTPS trong màn Connect cập nhật đúng APP_BASE_URL + Redirect URI App 1/App 2
- [ ] Lệnh Ngrok hiển thị đúng domain/cổng, không lộ App Secret
- [ ] Chọn Chrome Profile đã login → Connect mở tab OAuth với đúng session Facebook

---

## 5. Publish / Schedule / Rotation

- [ ] Tick Page → sang Chạy/Lịch → quay lại vẫn còn đúng Page đã chọn
- [ ] Reload/đóng mở app giữ Page, Page đang cấu hình, tab, bulk và rotation lần cuối
- [ ] Sửa config rồi chuyển Page ngay: Page cũ đã tự lưu, không ghi nhầm sang Page mới
- [ ] Bấm dòng Page vừa mở cấu hình vừa thêm đúng Page đó vào danh sách chạy
- [ ] Rotation/bulk chỉ nhận Page đã chọn, không rơi về tất cả Page khi checkbox DOM được dựng lại
- [ ] Caption random · media hash 1 lần  
- [ ] Rotation preview so-le App1↔App2  
- [ ] Gap cùng page đúng khung  
- [ ] Hẹn giờ 1–2 page thật (tuỳ)  
- [ ] Chạy ngay hiển thị đúng App · Admin · Page · bài số · chế độ đăng · giờ Việt Nam
- [ ] Không tạo lịch mới ở quá khứ; bài hẹn cũ chỉ đổi trạng thái sau khi Facebook xác nhận
- [ ] Job hiển thị % và thông báo rõ thành công/lỗi
- [ ] Media/caption lấy đúng folder từng Page và cập nhật số lượng khi job chạy
- [ ] Media random và không chọn file nằm sát các lần chọn gần nhất khi kho đủ lớn
- [ ] Caption vòng đầu đúng thứ tự; hết kho thì trộn đủ caption và chạy vòng tiếp
- [ ] Bài lỗi không làm media bị ghi nhận là đã chọn thành công
- [ ] Con trỏ caption độc lập với sequence photo/video/text và giữ đúng sau update
- [ ] Số media khả dụng không tính file có hash đã dùng
- [ ] Direct Local: task đầu đăng ngay; task sau tool chờ local rồi đăng trực tiếp, không có `scheduled_publish_time`
- [ ] Direct Local không đổi khi sửa khung giờ Hẹn Facebook; loại bài/số bài/gap lấy đúng khối Direct
- [ ] Tổng bài Hẹn Facebook bằng tổng các dòng khung; dòng 0/sai định dạng bị chặn
- [ ] Nhiều Page dùng cùng Caption folder không nhận trùng cùng vị trí; caption thành công làm số “chưa dùng” giảm live
- [ ] Popup tối đa 3, có nút ×, tự tắt, nhiều cập nhật được gom và mở lại job không phát lại popup cũ

## 5.1. Báo cáo / follower

- [ ] Báo cáo Page ghi đủ App · Admin/Profile · Page và follower
- [ ] CSV Page tạo theo ngày; Excel Page theo App có một sheet mỗi ngày
- [ ] CSV lịch sử tạo theo ngày; Excel lịch sử có một sheet mỗi ngày
- [ ] Tự xuất cuối ngày lúc 23:59 giờ Việt Nam
- [ ] Tăng/giảm follower 1 · 3 · 7 · 30 ngày đúng snapshot; thiếu dữ liệu ghi rõ
- [ ] Page thiếu quyền Facebook hiển thị cảnh báo quyền, không ghi follower giả

---

## 6. Auto-update

- [ ] Banner khi GitHub có version **mới hơn** + có file `.exe`  
- [ ] Bấm Cập nhật → chỉ thay exe · **license còn**  
- [ ] Release không có exe → báo thiếu asset, không crash  
- [ ] Update hiển thị tiến trình %/dung lượng trong app, không mở/spam CMD
- [ ] Sau download Electron thoát rồi thay đúng EXE tại chỗ và mở lại app

---

## 7. Gói khách (pack-customer)

- [ ] Có `VERSION.txt` đúng version  
- [ ] Có `README-KHACH.txt`, `.env.example`  
- [ ] Có `.exe` sau khi build+sync (hoặc ghi rõ “chưa build”)  
- [ ] Zip thử: giải nén máy sạch / folder mới chạy được (trial)  

---

## 8. GitHub (chỉ khi user đồng ý)

- [ ] User đã **OK** push / release  
- [ ] Không commit `.env`, private key, `data/`  
- [ ] Tag version = package.json  
- [ ] Release **có** `FB-Page-Studio-Desktop.exe`  

---

## 9. Bug lịch sử (đã xử lý)

| Bug | Xử lý |
|-----|--------|
| Black screen desktop | sqlite rebuild · env path |
| OAuth 2FA | browser ngoài |
| App2 fallback App1 | getMetaApp không fallback |
| Slot 30 ngày sai ms | `*60*1000` đủ |
| Update mất data? | Chỉ đổi exe · license trong data/ |
| Đổi tab/reload mất Page đã chọn | Lưu `posting_workspace_v1` trong SQLite, không đọc checkbox tạm |
| Sửa config rồi chuyển Page bị mất/ghi nhầm | Snapshot payload + flush đúng `pageId` trước khi chuyển |
| Máy mới không chọn được Page, API 500 | Schema mới có đủ `active_hours_json`, `active_hours_at`, `preferred_hours_json` |
| Thiết lập lần đầu ghi nhầm `.env` source | `FB_USER_DIR/FB_EXE_DIR` là đường dẫn bắt buộc |
| Direct Local lại tạo Facebook scheduled post | Mọi slot Direct là `kind: post`; job chờ local theo `run_at` |
| Page dùng chung Caption folder vẫn bắt đầu từ caption đầu | Thêm `caption_pool_state`, một con trỏ nguyên tử cho mỗi pool |
| Số bài Direct mâu thuẫn tổng khung giờ | Tách hai nguồn: Direct dùng số bài riêng; Hẹn Facebook dùng tổng các dòng khung |
| Popup OK/FAIL phủ kín màn hình | Tối đa 3, có nút đóng, tự hết hạn, gom batch và không replay job cũ |
| ZIP khó kiểm tra đúng EXE | Gói khách có EXE versioned + SHA-256 sidecar và kiểm tra giải nén/hash |
| VERSION.txt thư mục App còn v1.2.19 | Đã đồng bộ metadata sang v1.2.20 |
| Nhiều EXE cũ dễ mở nhầm | Chuyển bản v1.2.16–v1.2.19 vào `_old-versions`, giữ lại để phục hồi |
| Build lại nhưng release asset vẫn là file cũ cùng version | `release:verify` chặn hash lệch; bắt buộc chạy lại pack → release asset → ZIP → verify sau build cuối |

---

## Báo bug

Ghi: bước · màn · version topbar · license mode · DEV hay gói khách · log `desktop-startup.log`.
