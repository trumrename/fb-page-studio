# CHECK-BUG — Checklist kiểm thử FB Page Studio

> Trước mỗi ship / release. Đánh `[x]` khi OK.  
> **Phiên bản code:** 1.2.5
> **Gốc DEV:** `D:\fb-page-poster\`  
> **Gói KHÁCH:** `D:\fb-page-poster\pack-customer\`

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

---

## Báo bug

Ghi: bước · màn · version topbar · license mode · DEV hay gói khách · log `desktop-startup.log`.
