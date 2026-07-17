# Hướng dẫn cài đặt FB Page Studio — MÁY MỚI (chi tiết)

> Phiên bản gói: xem file `VERSION.txt` trong zip  
> App: **FB-Page-Studio-Desktop.exe**  
> GitHub Release: https://github.com/trumrename/fb-page-studio/releases  

---

## Mục lục

1. [Bạn cần chuẩn bị gì](#1-ban-can-chuan-bi-gi)  
2. [Tải app (đúng file)](#2-tai-app-dung-file)  
3. [Cài đặt file trên máy](#3-cai-dat-file-tren-may)  
4. [Tài khoản Facebook + Meta Developers](#4-tai-khoan-facebook--meta-developers)  
5. [Cài Ngrok (bắt buộc khi Connect)](#5-cai-ngrok-bat-buoc-khi-connect)  
6. [File `.env` — điền từng dòng](#6-file-env--dien-tung-dong)  
7. [Thứ tự chạy: App → Ngrok → Meta → Connect](#7-thu-tu-chay)  
8. [License (bản quyền)](#8-license-ban-quyen)  
9. [Sau khi Connect: page, kho media, caption](#9-sau-khi-connect)  
10. [Cập nhật app sau này](#10-cap-nhat-app-sau-nay)  
11. [Lỗi thường gặp](#11-loi-thuong-gap)  
12. [Giải thích nhanh: Ngrok / Meta](#12-giai-thich-nhanh)  

---

## 1. Bạn cần chuẩn bị gì

| Thứ | Bắt buộc? | Link / ghi chú |
|-----|-----------|----------------|
| Windows 10/11 64-bit | Có | — |
| File app từ admin / GitHub | Có | Xem mục 2 |
| Tài khoản Facebook | Có | https://www.facebook.com |
| Meta for Developers (tạo/dùng App) | Có | https://developers.facebook.com |
| Ngrok (tài khoản + cài tool) | Có* | https://ngrok.com — *cần khi Connect OAuth HTTPS |
| Chrome (khuyên) | Nên | https://www.google.com/chrome/ |
| Key license do admin cấp | Tuỳ | Không có → dùng trial ~7 ngày |

**Admin (máy gốc) gửi cho bạn:**

- File `FB-Page-Studio-Desktop.exe` (hoặc zip Windows)  
- `FB_APP_ID` + `FB_APP_SECRET` (hoặc thêm bạn làm Tester trên App của họ)  
- (Tuỳ) **License key**  
- **Không** cần: source code, `license-private.pem`

---

## 2. Tải app (đúng file)

### Link Release

https://github.com/trumrename/fb-page-studio/releases  

Chọn bản mới nhất (vd **v1.2.1**):  
https://github.com/trumrename/fb-page-studio/releases/tag/v1.2.1  

### Trong mục **Assets** — TẢI CÁI NÀY

| File | Mô tả |
|------|--------|
| **FB-Page-Studio-v…-Windows.zip** | **Khuyên dùng** — có exe + hướng dẫn |
| **FB-Page-Studio-Desktop.exe** | Chỉ file app |

### KHÔNG tải (dễ nhầm)

| File GitHub tự hiện | Là gì |
|---------------------|--------|
| **Source code (zip)** | Mã nguồn lập trình — **không phải** bản cài |
| **Source code (tar.gz)** | Cũng là source |

Tải Source code → không có app đúng, có thể thấy file cũ/hỏng → **đừng dùng**.

---

## 3. Cài đặt file trên máy

1. Tạo thư mục, ví dụ:

```
D:\FB-Page-Studio\
```

2. Giải nén zip vào đó (hoặc copy file exe vào).

3. Cấu trúc tối thiểu:

```
D:\FB-Page-Studio\
  FB-Page-Studio-Desktop.exe
  .env.example
  HUONG-DAN-MAY-MOI.md
  README-KHACH.txt
  VERSION.txt
```

4. Copy file `.env.example` → đổi tên thành **`.env`**  
   (cùng thư mục với file `.exe` — **rất quan trọng**)

5. Chưa cần chạy app vội — làm tiếp Meta + Ngrok + điền `.env`.

---

## 4. Tài khoản Facebook + Meta Developers

### 4.1. Facebook

- Đăng ký / đăng nhập: https://www.facebook.com  
- Nick này phải **quản lý fanpage** (Admin / Editor) bạn muốn đăng.  
- Nên bật 2FA (Authenticator) nếu Meta yêu cầu.

### 4.2. Meta for Developers — vào đây

1. Mở: https://developers.facebook.com  
2. Đăng nhập **cùng** (hoặc nick admin App).  
3. Lần đầu: có thể hiện “Get Started” / xác nhận tài khoản developer.

### 4.3. Hai trường hợp

#### A) Admin đã có Meta App — bạn chỉ Connect (phổ biến)

Admin làm giúp:

1. Vào App: https://developers.facebook.com/apps/  
2. Chọn App → **App roles** → **Roles**  
   https://developers.facebook.com/apps/ → chọn app → menu trái **App roles**  
3. **Add People** → thêm Facebook của bạn với vai trò **Tester** (hoặc Developer)  
4. Bạn vào Facebook → **Thông báo** → **Accept** lời mời Tester  

Bạn nhận từ admin: `FB_APP_ID`, `FB_APP_SECRET` (để ghi `.env`).

#### B) Tự tạo Meta App mới

1. https://developers.facebook.com/apps/create/  
2. Chọn loại phù hợp (thường **Business** / **Other** tùy giao diện Meta lúc đó)  
3. Đặt tên app → Create  
4. **Add product** → **Facebook Login** → **Set up** → Web  
5. Lấy **App ID** và **App Secret**:  
   - **App settings** → **Basic**: https://developers.facebook.com/apps/  
   - Chọn app → **Settings** → **Basic**  
   - App ID hiển thị sẵn; App Secret bấm **Show** (cần mật khẩu FB)  
6. **Facebook Login** → **Settings**:  
   - **Valid OAuth Redirect URIs** — sẽ dán URI ngrok ở mục 7 (làm sau khi có URL ngrok)

### 4.4. Quyền (Permissions) gợi ý

Trong `.env` thường có (khớp tool):

```text
pages_show_list
pages_manage_posts
pages_read_engagement
pages_manage_engagement
read_insights
public_profile
```

App **Dev mode**: chỉ user **Admin/Developer/Tester** của app login được.

---

## 5. Cài Ngrok (bắt buộc khi Connect)

### Ngrok dùng để làm gì?

Facebook chỉ gọi được địa chỉ **HTTPS công khai**.  
App chạy trong máy (`127.0.0.1:3847`) → internet không vào trực tiếp.  

**Ngrok** tạo link dạng `https://xxxx.ngrok-free.app` trỏ về máy bạn:

```
Facebook → https://xxxx.ngrok… → ngrok → app :3847
```

### 5.1. Đăng ký Ngrok

1. Mở: https://ngrok.com  
2. **Sign up** (đăng ký): https://dashboard.ngrok.com/signup  
3. Đăng nhập dashboard: https://dashboard.ngrok.com  

### 5.2. Lấy Authtoken

1. Vào: https://dashboard.ngrok.com/get-started/your-authtoken  
2. Copy **Your Authtoken** (chuỗi dài)

### 5.3. Cài Ngrok trên Windows

**Cách 1 — Tải file (dễ)**

1. https://ngrok.com/download  
2. Chọn **Windows** → Download  
3. Giải nén ra folder, ví dụ `C:\ngrok\ngrok.exe`  
4. Mở PowerShell:

```powershell
cd C:\ngrok
.\ngrok config add-authtoken DÁN_TOKEN_VÀO_ĐÂY
```

**Cách 2 — Winget (nếu có)**

```powershell
winget install ngrok.ngrok
ngrok config add-authtoken DÁN_TOKEN_VÀO_ĐÂY
```

### 5.4. Chạy Ngrok (sau khi app đã mở — xem mục 7)

```powershell
ngrok http 127.0.0.1:3847
```

**Lưu ý:** gõ **`127.0.0.1`**, không gõ `localhost` (tránh lỗi `[::1]` / ERR_NGROK_8012).

Cửa sổ ngrok hiện dòng **Forwarding**:

```text
https://abcd-1234.ngrok-free.app  →  http://127.0.0.1:3847
```

Copy phần `https://abcd-1234.ngrok-free.app` (URL **máy bạn lần này**).

**Ngrok free:** mỗi lần tắt/mở có thể **đổi URL** → phải cập nhật `.env` + Meta (mục 7).

---

## 6. File `.env` — điền từng dòng

Mở file `.env` bằng Notepad (cùng folder với `.exe`).

### Mẫu đầy đủ

```env
PORT=3847

# === ĐỔI THEO NGROK MÁY NÀY (sau khi chạy ngrok) ===
APP_BASE_URL=https://abcd-1234.ngrok-free.app
FB_REDIRECT_URI=https://abcd-1234.ngrok-free.app/auth/facebook/callback

# === COPY TỪ ADMIN / MÁY GỐC (giữ nguyên App ID) ===
FB_APP_ID=dán_App_ID_vào_đây
FB_APP_SECRET=dán_App_Secret_vào_đây
FB_APP_NAME=App 1

# App 2 (nếu admin có) — bỏ comment và điền
# FB_APP_ID_2=
# FB_APP_SECRET_2=
# FB_APP_NAME_2=App 2

FB_GRAPH_VERSION=v21.0
FB_SCOPES=pages_show_list,pages_manage_posts,pages_read_engagement,pages_manage_engagement,read_insights,public_profile

# Chuỗi ngẫu nhiên dài > 32 ký tự (copy máy gốc hoặc tự tạo)
TOKEN_ENCRYPTION_KEY=doi-thanh-chuoi-ngau-nhien-dai-hon-32-ky-tu!!

GITHUB_REPO=trumrename/fb-page-studio
UPDATE_ASSET=FB-Page-Studio-Desktop.exe
```

### Copy `.env` từ máy cũ?

| Được giữ | Phải đổi trên máy mới |
|----------|------------------------|
| `FB_APP_ID` / `SECRET` | `APP_BASE_URL` |
| `TOKEN_ENCRYPTION_KEY` | `FB_REDIRECT_URI` |
| `GITHUB_REPO` | (theo URL ngrok **đang chạy trên máy này**) |

---

## 7. Thứ tự chạy

Làm **đúng thứ tự** — hay sai → lỗi ngrok 8012 sau khi Accept Facebook.

### Bước 1 — Mở app

1. Chạy `FB-Page-Studio-Desktop.exe`  
2. **Giữ cửa sổ app** (không tắt)  
3. Kiểm tra: http://127.0.0.1:3847/app.html  
   - Vào được = app OK  

### Bước 2 — Mở Ngrok

```powershell
ngrok http 127.0.0.1:3847
```

Copy URL `https://....ngrok-free.app`

### Bước 3 — Sửa `.env`

```env
APP_BASE_URL=https://....ngrok-free.app
FB_REDIRECT_URI=https://....ngrok-free.app/auth/facebook/callback
```

Lưu file.

### Bước 4 — Meta: thêm Redirect URI

1. https://developers.facebook.com/apps/ → chọn App  
2. **Facebook Login** → **Settings**  
   (hoặc tìm **Valid OAuth Redirect URIs**)  
3. **Thêm** đúng:

```text
https://....ngrok-free.app/auth/facebook/callback
```

4. **Save changes**  
5. Có thể **giữ** URI máy cũ nếu máy cũ còn dùng (thêm, không xóa lung tung)

### Bước 5 — Restart app

- Tắt Page Studio → mở lại  
- Ngrok **vẫn chạy**  
- http://127.0.0.1:3847/app.html vẫn OK  

### Bước 6 — Connect Facebook

1. Trong app: **Pages / Connect** → **+ App 1**  
2. Chrome mở (ưu tiên) → login / Accept  
3. **Lúc bấm Accept:** app + ngrok **phải còn mở**  
4. Thấy trang **Đã kết nối** + nút **Quay về Pages**  

Nếu ra trang đỏ **ERR_NGROK_8012** → app không chạy trên 3847 hoặc ngrok sai (xem mục 11).

---

## 8. License (bản quyền)

1. Menu **License**  
2. **Trial:** dùng thử có giới hạn account/page  
3. **Có key:** dán key admin cấp → **Kích hoạt**  
4. **Machine ID:** hiện trên trang License — gửi admin nếu key gắn máy  

Cấp key (chỉ máy admin):

```powershell
cd D:\fb-page-poster
node scripts/gen-license.mjs --type employee --holder "Ten-NV" --days 90 --max-accounts 15 --max-pages 50
```

---

## 9. Sau khi Connect

### 9.1. Đồng bộ page

- **Pages** → Sync list / Sync details  

### 9.2. Kho media & caption

1. Menu **Cấu hình đăng**  
2. **Chọn 1 page** bên trái  
3. Cột phải:  
   - **📂 Chọn ổ/folder** → kho **ảnh/video**  
   - **📂 Chọn folder** → kho **caption** (file `.txt` / `.csv`)  
   - Folder **posted** (sau khi đăng)  
4. **Lưu config**  

**Caption `.txt`:** mỗi dòng = 1 caption.  

Mặc định nếu không chọn: `data\media\inbox`, `data\media\captions` cạnh exe.

### 9.3. Đăng bài

- **Vận hành** → chọn page → Đăng ngay / Hẹn giờ  
- Job: **Tạm dừng / Tiếp tục / Dừng**  

---

## 10. Cập nhật app sau này

1. App tự báo nếu GitHub có bản mới  
2. Bấm **Cập nhật ngay** (cần tải đúng **Desktop.exe** từ Assets)  
3. Hoặc tải zip mới → ghi đè `.exe`  
4. **Giữ** folder `data\` và `.env` (key, page, log không mất)  

Release: https://github.com/trumrename/fb-page-studio/releases  

---

## 11. Lỗi thường gặp

### ERR_NGROK_8012 (sau Accept login)

| Nguyên nhân | Cách xử lý |
|-------------|------------|
| App chưa mở / đã tắt | Mở lại app, giữ cửa sổ |
| http://127.0.0.1:3847 không vào được | Xem log `desktop-startup.log` |
| `ngrok http localhost:3847` | Đổi: `ngrok http 127.0.0.1:3847` |
| Copy `.env` URL ngrok máy cũ | Đổi URL ngrok máy này + Meta |
| Meta thiếu Redirect URI mới | Thêm URI đúng 100% |

### Invalid OAuth redirect URI

- So khớp **từng ký tự** URI trên Meta với `FB_REDIRECT_URI`  
- Có `https://`, có path `/auth/facebook/callback`  

### Không thấy page sau Connect

- Nick có quyền page?  
- Đã Accept lời mời **Tester**?  
- Bấm Sync list  

### Zip không có exe / file lạ

- Đã tải nhầm **Source code (zip)**  
- Tải lại **Assets** → `…-Windows.zip`  

### App đen / không mở

- `.env` phải **cạnh** `.exe`  
- Xem `desktop-startup.log`  

---

## 12. Giải thích nhanh

### Ngrok

Tạo HTTPS tạm để Facebook **gọi về app trên máy bạn** lúc Connect.  
Không thay Meta App, không lưu fanpage.

### Mỗi máy / mỗi lần mở ngrok free

| Việc | Có phải làm lại? |
|------|------------------|
| Tạo Meta App mới | **Không** (dùng chung App ID) |
| Thêm Tester | **1 lần / nick** |
| URL ngrok trong `.env` | **Có** nếu URL đổi |
| Thêm Redirect URI trên Meta | **Có** nếu URL ngrok **mới chưa** có trong list |

Muốn ít đụng Meta: dùng ngrok **domain cố định** (trả phí) — 1 URI dùng mãi.

### Sơ đồ

```
[Facebook Login]
       │
       ▼
https://xxx.ngrok-free.app/auth/.../callback
       │
       ▼
    [Ngrok trên máy]
       │
       ▼
http://127.0.0.1:3847  ← FB-Page-Studio-Desktop.exe (phải đang mở)
```

---

## Checklist in 1 phút trước Connect

- [ ] Tải đúng **Assets** (không phải Source code)  
- [ ] `.exe` + `.env` cùng folder  
- [ ] App mở, http://127.0.0.1:3847/app.html OK  
- [ ] `ngrok http 127.0.0.1:3847` đang chạy  
- [ ] `.env` URL = ngrok **hiện tại**  
- [ ] Meta đã **Save** Redirect URI đó  
- [ ] Nick là **Tester**  
- [ ] License trial hoặc đã dán key  

---

## Link tổng hợp

| Việc | Link |
|------|------|
| Tải app (Release) | https://github.com/trumrename/fb-page-studio/releases |
| Facebook | https://www.facebook.com |
| Meta Developers | https://developers.facebook.com |
| Tạo / quản lý App | https://developers.facebook.com/apps/ |
| Ngrok trang chủ | https://ngrok.com |
| Ngrok đăng ký | https://dashboard.ngrok.com/signup |
| Ngrok authtoken | https://dashboard.ngrok.com/get-started/your-authtoken |
| Ngrok download | https://ngrok.com/download |
| Chrome | https://www.google.com/chrome/ |
| Kiểm tra app local | http://127.0.0.1:3847/app.html |

---

**Hết.** Làm theo mục **7 (Thứ tự chạy)** là quan trọng nhất trên máy mới.
