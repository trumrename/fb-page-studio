# App Setup — FB Page Studio (Desktop)

## A. Cài 1 lần (máy bạn)

### 1. File app
```
C:\Users\NCpc\fb-page-poster\dist-desktop\FB-Page-Studio-Desktop.exe
```
Hoặc chạy dev:
```powershell
cd C:\Users\NCpc\fb-page-poster
npm install
npm run desktop
```

### 2. File `.env` (bắt buộc)

**Desktop exe:** đặt `.env` **cùng folder** với file `.exe`  
**Dev:** file `C:\Users\NCpc\fb-page-poster\.env`

Copy từ `.env.example`:

```env
PORT=3847
APP_BASE_URL=https://YOUR-NGROK-URL
FB_APP_ID=your_app_id
FB_APP_SECRET=your_app_secret
FB_REDIRECT_URI=https://YOUR-NGROK-URL/auth/facebook/callback
FB_GRAPH_VERSION=v21.0
FB_SCOPES=pages_show_list,pages_manage_posts,pages_read_engagement,pages_manage_engagement,read_insights,public_profile
TOKEN_ENCRYPTION_KEY=doi-thanh-chuoi-ngau-nhien-dai-32-ky-tu
GITHUB_REPO=trumrename/fb-page-studio
```

| Biến | Ý nghĩa |
|------|---------|
| `FB_APP_ID` / `FB_APP_SECRET` | Meta App → Settings → Basic |
| `APP_BASE_URL` | URL HTTPS public (ngrok) |
| `FB_REDIRECT_URI` | = `APP_BASE_URL` + `/auth/facebook/callback` |
| `TOKEN_ENCRYPTION_KEY` | Khóa mã hóa token local (đừng share) |
| `GITHUB_REPO` | Cập nhật app từ GitHub Releases |

> OAuth Facebook **cần HTTPS**. Local `http://localhost` thường **không** thêm được vào redirect khi app Live.

---

## B. Meta App (developers.facebook.com) — 1 lần

1. Vào https://developers.facebook.com → **My Apps** → app của bạn  
2. **Settings → Basic**  
   - Copy **App ID**, **App Secret** → `.env`  
3. Thêm product **Facebook Login** (nếu chưa)  
4. **Facebook Login → Settings → Valid OAuth Redirect URIs**  
   thêm đúng:
   ```
   https://YOUR-NGROK-URL/auth/facebook/callback
   ```
5. **App roles → Roles**  
   - Thêm **mọi nick FB** sẽ Connect (Admin / Developer / **Tester**)  
   - Nick Tester phải **Accept** lời mời  
6. Quyền dùng (Dev mode + roles là đủ test):
   - `pages_show_list`
   - `pages_manage_posts`
   - `pages_read_engagement`
   - `pages_manage_engagement` (comment)
   - `read_insights` (followers growth)
   - `public_profile`

**App Live + user ngoài roles** → cần **App Review** cho permission đăng bài.

---

## C. Ngrok (HTTPS cho OAuth)

```powershell
ngrok http 3847
```

Copy URL dạng `https://xxxx.ngrok-free.dev`:

1. Gán vào `.env`:
   - `APP_BASE_URL=https://xxxx.ngrok-free.dev`
   - `FB_REDIRECT_URI=https://xxxx.ngrok-free.dev/auth/facebook/callback`
2. Dán **cùng URL** vào Meta → Valid OAuth Redirect URIs  
3. **Restart app** (đóng exe → mở lại)

Mỗi lần ngrok free đổi subdomain → phải cập nhật lại `.env` + Meta.

---

## D. Chạy app lần đầu

1. Double-click **FB-Page-Studio-Desktop.exe**  
2. Cửa sổ **FB Page Studio** mở (có logo)  
3. Vào **Pages / Connect** → **+ Connect Facebook**  
4. Login nick (đã là Tester) → cho phép page  
5. **Sync list** → **Sync details** (followers)  
6. Bỏ media vào:
   ```
   data\media\inbox\
   ```
7. Caption:
   ```
   data\media\captions\   (.txt / .csv)
   ```
8. **Vận hành** → tick page → Đăng / Hẹn giờ  
9. **Anti-spam** → giữ preset Recommended  

---

## E. Cấu trúc folder khi chạy Desktop

```
folder-cua-ban\
  FB-Page-Studio-Desktop.exe
  .env
  data\                 ← tự tạo
    app.db
    media\inbox\
    media\posted\
    media\captions\
    exports\
      dang_bai_chi_tiet.csv
      dang_bai_chi_tiet.xlsx
```

---

## F. Checklist nhanh

- [ ] Có `.exe` desktop  
- [ ] Có `.env` cạnh exe / project  
- [ ] Meta App ID + Secret  
- [ ] Ngrok HTTPS đang chạy → port **3847**  
- [ ] Redirect URI khớp Meta + `.env`  
- [ ] Nick FB đã là Tester/Dev và Accept  
- [ ] Connect thành công → thấy page  
- [ ] Có file trong `inbox` + caption  
- [ ] Anti-spam bật  

---

## G. Lỗi thường gặp

| Lỗi | Cách xử |
|-----|---------|
| URL redirect không SSL | Dùng ngrok HTTPS |
| User chưa đủ role | Add Tester + Accept |
| Connect xong 0 page | Nick không quản page / thiếu `pages_show_list` |
| Đăng fail permission | Re-Connect với scope `pages_manage_posts` |
| Port 3847 bận | Tắt app cũ / đổi `PORT` |
| MEDIA_DUP | File đã đăng — dùng ảnh khác |
| Ngrok URL đổi | Sửa `.env` + Meta redirect |

---

## H. Lệnh hữu ích

```powershell
cd C:\Users\NCpc\fb-page-poster

# Desktop (dev)
npm run desktop

# Build lại desktop + logo
npm run build:desktop

# Chỉ server web (không cửa sổ app)
npm start
```

Chi tiết dùng hàng ngày: **HUONG-DAN.md**  
GitHub release: https://github.com/trumrename/fb-page-studio  
