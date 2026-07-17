# CHECK-BUG — Checklist kiểm thử FB Page Studio

> Chạy trước mỗi release. Đánh dấu `[x]` khi OK.  
> Phiên bản: **1.2.0**

---

## 0. Tự động (bắt buộc)

```powershell
cd D:\fb-page-poster
node scripts/test-requirements.mjs
# Kỳ vọng: ALL CHECKS PASSED (81/81)
```

- [ ] Suite requirements pass

---

## 1. Khởi động

- [ ] `npm start` hoặc Desktop exe lên được, không black screen
- [ ] Port 3847 (hoặc PORT trong `.env`) không conflict
- [ ] `/api/meta` trả `version` + `license`
- [ ] Log không spam error token/db

---

## 2. License

- [ ] `/license.html` hiện trial hoặc key
- [ ] Machine ID hiển thị
- [ ] Key giả → báo chữ ký sai
- [ ] Key hết hạn → không active
- [ ] Key bind máy khác → từ chối
- [ ] Key đúng → kích hoạt, đăng được
- [ ] Xóa key → về trial/hết hạn
- [ ] Hết trial + không key → **chặn đăng / hẹn giờ**
- [ ] Trial vượt max account → chặn Connect account mới

```powershell
# Cấp key test (máy dev có private key)
node scripts/gen-license.mjs --type commercial --holder "Test" --days 30 --max-accounts 20 --max-pages 80
```

---

## 3. Multi Meta App / OAuth

- [ ] `GET /auth/apps` list app1 (+ app2 nếu có env)
- [ ] Connect **App 1** → account badge App 1
- [ ] Connect **App 2** (khi đã `FB_APP_ID_2`) → badge App 2
- [ ] App 2 chưa config → lỗi rõ, **không** login nhầm App 1
- [ ] 2FA: mở Chrome/Edge external OK
- [ ] Redirect URI khớp Meta (ngrok)
- [ ] Cùng nick Connect 2 app = 2 account rows

---

## 4. Pages / Sync

- [ ] Sync list pages
- [ ] Sync details followers (+7d nếu có)
- [ ] Export Excel/CSV
- [ ] Xóa account không crash

---

## 5. Publish

- [ ] Caption random từ txt/csv
- [ ] Ảnh inbox → posted sau OK
- [ ] Media hash: đăng lại cùng file → anti-spam chặn
- [ ] Text post OK · log CSV
- [ ] Interval / cooldown page hoạt động

---

## 6. Schedule + Rotation

- [ ] Bulk dry-run plan có slot
- [ ] Rotation **Xem thứ tự**: App1 P1 → App2 P1 → …
- [ ] Khung sáng/tối + gap ≥ cài đặt (cùng page)
- [ ] Slot quá khứ → +1 ngày (còn hợp lệ Graph)
- [ ] Anti-spam bulk cắt khi > cap (15 page / 40 slot)
- [ ] Hẹn giờ thật 1–2 page (kiểm tra FB scheduled)

---

## 7. Anti-spam

- [ ] Recommended: global 12/h, 40/day
- [ ] Force ignore OFF mặc định
- [ ] Graph lỗi rate → backoff
- [ ] App usage cao → pause publish

---

## 8. Jobs UI

- [ ] Progress % tổng + từng task
- [ ] Toast OK/FAIL
- [ ] Job sequential (không 10 request cùng lúc)

---

## 9. Desktop / Update

- [ ] Portable exe mở được
- [ ] `.env` cạnh exe được đọc
- [ ] Nút cập nhật GitHub (nếu có release asset đúng tên)

---

## 10. Bảo mật / ship

- [ ] Không ship `.env` / `data/app.db` có token prod
- [ ] Không ship `keys/license-private.pem`
- [ ] `.gitignore` chặn private key + issued keys
- [ ] Release note ghi version + changelog ngắn

---

## Bug đã gặp & xử lý (lịch sử)

| Bug | Xử lý |
|-----|--------|
| Black screen desktop | better-sqlite3 rebuild Electron · env path |
| OAuth validate / 2FA | external browser · không rerequest mặc định |
| Caption random trùng | exclude đã dùng trong vòng |
| App2 fallback App1 | `getMetaApp` không fallback key khác |
| Slot >12h bị skip “30 ngày” | sửa `30*24*60*60*1000` |
| EADDRINUSE | stop-port / đổi PORT |

---

## Khi báo bug

Ghi: **bước tái hiện · màn hình · log** (`desktop-startup.log` / console) · version `/api/meta` · license mode · app1/app2.
