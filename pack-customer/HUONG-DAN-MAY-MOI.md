# Hướng dẫn cài FB Page Studio — MÁY MỚI (đầy đủ)

Phiên bản gói: xem `VERSION.txt` · Release: https://github.com/trumrename/fb-page-studio/releases

---

## 0. Chuẩn bị (máy admin / máy gốc gửi)

Gửi cho máy mới **một trong hai**:

| Cách | Nội dung |
|------|----------|
| **A. Zip Release (khuyên)** | `FB-Page-Studio-vX.X.X-Windows.zip` trên GitHub **Assets** |
| **B. Folder pack-customer** | Từ máy gốc: `D:\fb-page-poster\pack-customer\` |

### Tải GitHub — ĐÚNG / SAI

| ĐÚNG (Assets) | SAI |
|---------------|-----|
| `FB-Page-Studio-v…-Windows.zip` | **Source code (zip)** |
| `FB-Page-Studio-Desktop.exe` | **Source code (tar.gz)** |

Source code = mã lập trình, **không phải** bản cài, dễ thấy file cũ/hỏng, **không có** app chạy đúng.

### Admin cần làm thêm

1. Meta App: thêm nick Facebook máy mới vào **Roles → Testers** (nếu app Dev mode)  
2. (Tuỳ) cấp **license key**  
3. Có thể gửi sẵn App ID/Secret (trong `.env` mẫu) — **không** gửi `keys/license-private.pem`

---

## 1. Cài file trên máy mới

1. Tạo folder, ví dụ: `D:\FB-Page-Studio\`
2. Giải nén zip (hoặc copy) vào đó:

```
D:\FB-Page-Studio\
  FB-Page-Studio-Desktop.exe    ← app
  .env.example
  README-KHACH.txt
  HUONG-DAN-MAY-MOI.md          ← file này
  VERSION.txt
  DOC-CAI-DAT.txt               ← nếu có trong zip
```

3. Copy `.env.example` → đổi tên thành **`.env`** (cùng folder với `.exe`)

---

## 2. File `.env` — copy từ máy gốc được không?

### Được copy (giữ nguyên)

```env
FB_APP_ID=...
FB_APP_SECRET=...
FB_APP_NAME=App 1
# App 2 nếu có:
# FB_APP_ID_2=...
# FB_APP_SECRET_2=...

TOKEN_ENCRYPTION_KEY=...   # copy cùng cũng được
GITHUB_REPO=trumrename/fb-page-studio
UPDATE_ASSET=FB-Page-Studio-Desktop.exe
PORT=3847
FB_SCOPES=...
FB_GRAPH_VERSION=v21.0
```

### BẮT BUỘC ĐỔI trên máy mới

```env
# SAI nếu để URL ngrok máy cũ
APP_BASE_URL=https://URL-NGROK-MAY-MOI
FB_REDIRECT_URI=https://URL-NGROK-MAY-MOI/auth/facebook/callback
```

**Lý do:** ngrok free **đổi URL mỗi lần / mỗi máy**. Copy nguyên URL máy gốc → login Facebook xong bị **ERR_NGROK_8012** hoặc callback hỏng.

---

## 3. Thứ tự chạy (quan trọng — hay sai ở đây)

```
① Mở app Desktop TRƯỚC
② Kiểm tra local OK
③ Bật ngrok
④ Sửa .env + Meta theo URL ngrok
⑤ Restart app
⑥ Connect Facebook (app + ngrok VẪN MỞ)
```

### Bước ① — Mở app

- Chạy: `FB-Page-Studio-Desktop.exe`
- **Giữ cửa sổ app**, không tắt

### Bước ② — Kiểm tra app sống

Mở Chrome: http://127.0.0.1:3847/app.html  

| Kết quả | Ý nghĩa |
|---------|---------|
| Vào được Page Studio | App OK, cổng 3847 OK |
| Không vào được | App crash / thiếu `.env` → xem `desktop-startup.log` cạnh exe |

### Bước ③ — Ngrok

Cài ngrok (nếu chưa): https://ngrok.com → authtoken  

```powershell
ngrok http 127.0.0.1:3847
```

Dùng **`127.0.0.1`**, **không** gõ `localhost` (tránh lỗi `[::1]` / 8012).

Giữ cửa sổ ngrok mở. Copy URL dạng:

`https://xxxx.ngrok-free.app`

### Bước ④ — Sửa `.env` máy mới

```env
PORT=3847
APP_BASE_URL=https://xxxx.ngrok-free.app
FB_REDIRECT_URI=https://xxxx.ngrok-free.app/auth/facebook/callback

FB_APP_ID=...          # từ máy gốc / admin
FB_APP_SECRET=...
TOKEN_ENCRYPTION_KEY=...
GITHUB_REPO=trumrename/fb-page-studio
UPDATE_ASSET=FB-Page-Studio-Desktop.exe
```

### Bước ⑤ — Meta Developers

1. https://developers.facebook.com → App của bạn  
2. **Facebook Login → Settings** (hoặc Valid OAuth Redirect URIs)  
3. **Thêm** (không xóa URI máy cũ nếu máy cũ còn dùng):

```
https://xxxx.ngrok-free.app/auth/facebook/callback
```

4. **App roles → Roles**: nick sẽ Connect = **Tester** / Developer  
5. Lưu

### Bước ⑥ — Restart app + Connect

1. **Tắt** Page Studio → **mở lại** (đọc `.env` mới)  
2. Kiểm tra lại: http://127.0.0.1:3847/app.html  
3. Ngrok **vẫn chạy**, URL **trùng** `.env`  
4. Trong app: **Pages → + App 1** (mở Chrome)  
5. Login / Accept Facebook  
6. Phải thấy **“Đã kết nối”** + nút **Quay về Pages** — **không** trang đỏ ngrok 8012  

**Lúc bấm Accept:** app + ngrok **phải còn chạy**.

---

## 4. License

| | |
|--|--|
| Lần đầu | Trial ~7 ngày (giới hạn account/page) |
| Nhân viên / khách | Admin cấp key → menu **License** → dán key → Kích hoạt |
| Machine ID | Trong **License** — gửi admin nếu key gắn máy |

Key **giữ** sau khi cập nhật app (nằm trong `data\license.json`).

---

## 5. Sau khi Connect xong

1. **Pages** → Sync list / Sync details  
2. **Cấu hình đăng** → chọn 1 page:  
   - 📂 **Kho ảnh/video**  
   - 📂 **Kho caption** (.txt/.csv)  
   - 📂 folder **posted** (tuỳ)  
   - **Lưu config**  
3. **Vận hành** → chọn page → Đăng ngay / Hẹn giờ  
4. Job: **Tạm dừng / Tiếp tục / Dừng** nếu cần  

---

## 6. Cập nhật bản mới sau này

1. App tự báo nếu GitHub có version mới  
2. Bấm **Cập nhật ngay** (Release phải có file `.exe`)  
3. Hoặc tải zip mới từ Release → ghi đè `.exe`  
4. **Giữ** folder `data\` + `.env` (key, page, log)

---

## 7. Lỗi thường gặp (máy mới)

### ERR_NGROK_8012 (sau Accept login)

| Nguyên nhân | Cách xử lý |
|-------------|------------|
| App chưa mở / đã tắt | Mở app, giữ cửa sổ |
| 3847 không vào được | Sửa crash / `.env` / xem log |
| ngrok dùng `localhost` | Đổi: `ngrok http 127.0.0.1:3847` |
| Copy `.env` URL ngrok máy cũ | Đổi `APP_BASE_URL` + `FB_REDIRECT_URI` |
| Meta chưa thêm redirect mới | Thêm URI ngrok máy mới |

### Không vào được Facebook Login / invalid redirect

- Redirect URI trên Meta **khớp 100%** với `.env`  
- URL ngrok đổi → sửa cả `.env` + Meta + restart app  

### Connect xong không thấy page

- Nick có quyền admin page?  
- Dev mode: nick đã là **Tester**?  
- Bấm Sync list  

### App đen / không lên

- `.env` cạnh `.exe`?  
- Xem `desktop-startup.log` cạnh exe  
- Tắt process chiếm port 3847  

### Zip không có exe / toàn file lạ

- Đã tải nhầm **Source code (zip)**  
- Tải lại **Assets** → `…-Windows.zip` hoặc `…-Desktop.exe`  

---

## 8. Checklist 1 phút trước khi Connect

- [ ] Có `FB-Page-Studio-Desktop.exe` + `.env` cùng folder  
- [ ] App đang mở, http://127.0.0.1:3847/app.html OK  
- [ ] `ngrok http 127.0.0.1:3847` đang chạy  
- [ ] `.env` `APP_BASE_URL` + `FB_REDIRECT_URI` = URL ngrok **hiện tại**  
- [ ] Meta đã thêm redirect URI đó  
- [ ] Nick là Tester trên Meta App  
- [ ] License trial hoặc đã kích hoạt key  

---

## 9. Sơ đồ nhanh

```
Máy mới
  │
  ├─ Desktop.exe  ──► 127.0.0.1:3847  (app)
  │
  ├─ ngrok  ──► https://xxx.ngrok…  ──► 127.0.0.1:3847
  │
  ├─ .env: APP_BASE_URL + REDIRECT = https://xxx.ngrok…
  │
  └─ Meta: Redirect URI + Tester nick
           │
           └─ Chrome Connect → Accept → callback qua ngrok → app
```

---

**Tóm:**  
Máy mới = **exe + .env (đổi URL ngrok) + app mở + ngrok 127.0.0.1:3847 + Meta redirect/tester**.  
Copy nguyên `.env` máy cũ **chỉ** giữ App ID/Secret — **URL ngrok phải làm lại**.
