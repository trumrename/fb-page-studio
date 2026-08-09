# CHECK-BUG — Checklist kiểm thử FB Page Studio

> **Trước mỗi ship / giao khách.** Đánh `[x]` khi OK.  
> **Phiên bản target:** **v1.2.72+**  
> **Source DEV:** `C:\Users\NCpc\fb-page-poster\`  
> **Data Setup:** `%APPDATA%\fb-page-studio\`  
> **Tải latest:** https://github.com/trumrename/fb-page-studio/releases/latest/download/FB-Page-Studio-Setup.exe  

Xem thêm: `TONG-QUAN.md` · `TRANG-THAI-HIEN-TAI.md` · `DOC-INDEX.md`

---

## 0. Baseline ship (điền khi release)

| Hạng mục | Giá trị |
|----------|---------|
| Version `package.json` | |
| Tag GitHub | `v` |
| Setup path local | `F:\FB-Page-Studio\dist-desktop-oauth\FB-Page-Studio-Setup-v….exe` |
| SHA-256 Setup | |
| `npm test` | PASS / FAIL |
| `npm run test:delete-live` (nếu ship delete) | PASS / SKIP / FAIL |
| Cài đè giữ env | PASS / FAIL |

---

## 1. Phân biệt gói & an toàn

- [ ] Fix/build trên **source DEV**, không chỉ sửa pack rời  
- [ ] `pack-customer` **không** chứa: `license-private.pem`, App Secret, `data/app.db` token, folder `src/`  
- [ ] `.env` khách = public-safe (relay, không secret bắt buộc trên máy khách nếu relay exchange)  
- [ ] Setup `deleteAppDataOnUninstall: false` (không xóa AppData khi uninstall)  
- [ ] Cài đè: version UI đổi, **token/page list còn**  

---

## 2. Tự động (DEV)

```powershell
cd C:\Users\NCpc\fb-page-poster
npm test
```

- [ ] `test-requirements` ALL CHECKS PASSED  
- [ ] Caption pool PASS  
- [ ] Clean runtime PASS  
- [ ] Delete date-filter unit PASS  

**Ship có thay xóa / Graph bulk:**

```powershell
$env:FB_USER_DIR = "$env:APPDATA\fb-page-studio"
npm run test:delete-live
```

- [ ] LIVE list posts OK  
- [ ] LIVE delete `shared_story` OK (nếu page có share)  
- [ ] Report: `Tổng Hợp Tool\pack-dev\RELEASE-GATE-DELETE.json`  

---

## 3. Cài đặt & khởi động

- [ ] Setup cài / cài đè không lỗi  
- [ ] Mở app không black screen  
- [ ] Title cửa sổ có **version đúng** (vd `v1.2.72`)  
- [ ] `%APPDATA%\fb-page-studio\.env` tồn tại  
- [ ] Log: `desktop-startup.log` — `USER_DIR` = AppData, `isPackaged true`  
- [ ] `/api/health` hoặc app load `app.html` OK  
- [ ] License hiển thị (trial / commercial)  

---

## 4. OAuth / Connect

- [ ] Connect App 1 mở browser  
- [ ] **Chrome Portable:** `FB_BROWSER_PATH=...\ChromePortable.exe`  
- [ ] Mở OAuth = **cùng** Portable đã login (không profile trống)  
- [ ] **Không** set `FB_CHROME_USER_DATA_DIR` / `FB_CHROME_PROFILE` (gây logout)  
- [ ] Callback `modelswiki.top` / relay OK  
- [ ] Page list sync sau Connect  
- [ ] 2FA / captcha: user hoàn tất 1 lần, session **không** bị out ngay sau Connect  

---

## 5. Chrome Portable (máy khách) — logout / captcha / extension

- [ ] Connect **không** spawn `chrome.exe --user-data-dir=...` (log: `portable-launcher` / URL-only)  
- [ ] Sau Connect: FB vẫn login trên Portable  
- [ ] Extension vẫn trên profile Portable (không “mất hết”)  
- [ ] Sau **đăng bài** bulk vừa: session browser vẫn (hoặc chỉ captcha Meta nếu spam quá)  
- [ ] Sau **xóa bulk**: tool **không** tự thoát; tray vẫn sống nếu đóng cửa sổ  

**Nếu vẫn captcha sau bulk lớn:** chia nhỏ job (Meta security, không phải cookie wipe).

---

## 6. Đăng bài / Direct / Hẹn FB

- [ ] Chọn Page → config caption/media → lưu  
- [ ] Direct Local: task đầu đăng ngay (tool mở)  
- [ ] Hẹn Facebook: post scheduled trên page  
- [ ] Fail list + retry task lỗi  
- [ ] Anti-spam / quota không tạo task chắc vượt  
- [ ] Reload app: page selection / config còn  

---

## 7. Rotation

- [ ] Plan so-le App/Page  
- [ ] Run-now preview  
- [ ] Gap cùng page  
- [ ] Cửa sổ giờ VN  

---

## 8. Xóa Fanpage (critical)

### 8.1 UI & filter ngày
- [ ] «Đến hết ngày» = 23:59:59 — bài **sau** ngày đó **không** xóa  
- [ ] Log: `Lọc ngày: từ … → đến …`  
- [ ] Log: `bỏ N object NGOÀI khoảng` khi có filter  
- [ ] Full wipe: để trống ngày  

### 8.2 List & xóa
- [ ] List có edges (published / feed / videos / …)  
- [ ] Progress OK/Fail/Còn lại không loạn nhảy  
- [ ] Rate limit #4: GLOBAL pause 1 countdown, tự resume  
- [ ] Batch // adaptive (log `//n/m adaptive` nếu có)  

### 8.3 Share của page
- [ ] Page có `shared_story` → xóa được (OK tăng)  
- [ ] Không nhầm với visitor (thường fail #200)  

### 8.4 Kết quả / fail Meta (chấp nhận được)
- [ ] `#200 same app` photo → fail list, không crash  
- [ ] `#200 not created by application` → fail list  
- [ ] `Unsupported DELETE` → fail list  
- [ ] CSV / TXT fail tải được  
- [ ] Tool **không out** khi job done (v1.2.70+)  

### 8.5 Branding
- [ ] Checkbox avatar/cover **mặc định tắt**  
- [ ] Full wipe + tick → thử xóa (có thể #200)  
- [ ] Lọc ngày + không tick → **không** xóa avatar  

---

## 9. Group delete

- [ ] Parse post ID / link  
- [ ] List feed group (nếu Graph cho) hoặc báo lỗi rõ  
- [ ] Không treo vô hạn  

---

## 10. Update / license

- [ ] Check update thấy latest GitHub  
- [ ] License còn sau cài đè Setup  
- [ ] Machine ID ổn định  

---

## 11. Không được ship nếu

- [ ] `npm test` fail (trừ flake đã ghi nhận + ship feature không liên quan)  
- [ ] Delete gate fail khi thay code xóa  
- [ ] Setup version ≠ tag  
- [ ] pack-customer lộ secret  
- [ ] Chrome Portable vẫn ép `--user-data-dir` (log)  

---

## 12. Smoke máy khách (5 phút)

1. Cài Setup latest đè  
2. Mở app → version đúng  
3. Page list còn  
4. Dry-run xóa 1 page (0 delete) hoặc preview  
5. Connect (nếu cần) trên Portable — session giữ  
6. Đóng cửa sổ → tray → mở lại  

---

## 13. Ghi chú lỗi hay gặp

| Triệu chứng | Hướng xử lý |
|-------------|-------------|
| Out app sau xóa 7k bài | Đã fix 1.2.70 SSE slim — cài ≥1.2.70 |
| FB logout + captcha Portable | ≥1.2.72 + `FB_BROWSER_PATH=ChromePortable.exe` only |
| Mất extension | Profile trống — chọn đúng profile Portable |
| #200 xóa | Meta ownership — không fix bằng list thêm |
| #4 liên tục | list//1, chờ GLOBAL pause, ít page song song |

---

*Cập nhật: 2026-07-30 · checklist cho **v1.2.72+***
