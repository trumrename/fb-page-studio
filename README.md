# FB Page Studio

Tool **multi-account / multi-page** dùng **Facebook Graph API chính thống** (v1.2.20).

- OAuth multi-account · multi Meta App · list page · followers · export  
- Đăng feed (text/ảnh/video) · caption pool · anti-spam  
- **Direct Local** (tool canh giờ) hoặc **hẹn giờ Facebook**  
- Job tiến trình + **đăng lại task lỗi**  
- **1 file `.exe` portable** + cập nhật từ GitHub Releases  

## Khách (không cần Node)

1. Tải Release: `FB-Page-Studio-Desktop-v1.2.20.exe` hoặc ZIP `FB-Page-Studio-v1.2.20-Windows.zip`  
2. Chạy EXE → thiết lập Meta App + Ngrok trong UI  
3. Dán license key (hoặc trial)  

Chi tiết: `pack-customer/README-KHACH.txt` · `HUONG-DAN-MAY-MOI.md`

## Dev / build

```powershell
npm install
npm test
npm run build:desktop
npm run pack:all          # pack-customer + pack-dev + ZIP
npm run release:verify
```

- Admin cấp key: `Admin-Quan-Ly/MENU-ADMIN.bat`  
- GitHub release: **[GITHUB.md](./GITHUB.md)**

---

## Yêu cầu (dev)

- Node.js **18+**
- 1 **Meta App** tại [developers.facebook.com](https://developers.facebook.com)
- Các nick Facebook của bạn (Dev mode → thêm làm **Tester / Developer**)

---

## Cấu hình Meta App (1 lần)

1. Create App → thêm product **Facebook Login**  
2. **Facebook Login → Settings → Valid OAuth Redirect URIs**  
   - App **Live** thường **bắt buộc `https://`** (lỗi: *"URL mới phải dùng SSL"*).  
   - `http://localhost...` hay **bị từ chối** khi thêm/sửa.  
   - Dùng URL HTTPS (ngrok — xem bên dưới), ví dụ:  
     ```
     https://xxxx.ngrok-free.app/auth/facebook/callback
     ```
3. **App settings → Basic** → copy **App ID**, **App Secret**  
4. **App roles** → thêm **mọi nick** (Tester/Developer) + Accept invite  
5. Permissions (Standard + Roles):  
   `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `public_profile`

**1 App cho tất cả nick** — không tạo 1 app / 1 account.

---

## HTTPS OAuth (bắt buộc với nhiều app Live)

Meta: redirect URI phải **https**. Cách nhanh trên máy local:

### Cách A — ngrok (khuyên dùng)

1. Cài [ngrok](https://ngrok.com/download), đăng ký lấy authtoken.  
2. Chạy tool:
   ```bash
   npm start
   ```
3. Terminal khác:
   ```bash
   ngrok http 3847
   ```
4. Copy URL dạng `https://abcd-123.ngrok-free.app`  
5. Sửa `.env`:
   ```env
   APP_BASE_URL=https://abcd-123.ngrok-free.app
   FB_REDIRECT_URI=https://abcd-123.ngrok-free.app/auth/facebook/callback
   ```
6. Meta → Facebook Login → **Valid OAuth Redirect URIs** = đúng `FB_REDIRECT_URI`  
7. Mở tool bằng **URL ngrok** (https), bấm **Connect Facebook**  
8. Mỗi lần restart ngrok (free) URL đổi → cập nhật lại `.env` + Meta

### Cách B — domain thật có SSL

Deploy tool lên VPS/host có HTTPS, trỏ redirect + `APP_BASE_URL` về domain đó.

---

## Cài & chạy

```bash
cd C:\Users\NCpc\fb-page-poster
copy .env.example .env
# Sửa .env: FB_APP_ID, FB_APP_SECRET, TOKEN_ENCRYPTION_KEY
# + APP_BASE_URL / FB_REDIRECT_URI (https ngrok hoặc domain)

npm install
npm start
# terminal 2: ngrok http 3847
```

Mở **URL https** (ngrok), không chỉ `http://localhost` khi Connect Facebook.

**Thêm nhiều account:** bấm **Connect Facebook** nhiều lần.  
Mỗi lần login nick khác (logout FB hoặc Chrome profile khác).

---

## API

| Method | Path | Mô tả |
|--------|------|--------|
| GET | `/auth/facebook` | Bắt đầu OAuth |
| GET | `/auth/facebook/callback` | Callback Meta |
| GET | `/api/accounts` | List accounts |
| POST | `/api/accounts/:id/sync` | Sync lại pages |
| DELETE | `/api/accounts/:id` | Xóa account |
| GET | `/api/pages?account_id=&q=&limit=&offset=` | List pages (scale) |
| GET | `/api/stats` | Thống kê |

Token **không** trả về API JSON (chỉ lưu mã hóa trong SQLite `data/app.db`).

---

## Cấu trúc

```
fb-page-poster/
  .env.example
  package.json
  public/index.html          # UI
  src/
    server.js
    config.js
    db/index.js              # SQLite schema
    services/
      facebook.js            # Graph OAuth + /me/accounts
      accounts.js            # multi-account business logic
      crypto.js              # encrypt tokens
    routes/
      auth.js
      api.js
  data/                      # app.db (gitignored)
```

---

## Scale (số lượng lớn)

- `/me/accounts` loop `paging.next` (limit 100/batch)  
- SQLite WAL + index `page_id`, `account_id`  
- `GET /api/pages` có `limit` / `offset` / search  
- Transaction upsert pages theo account  

Hàng nghìn page trên vài chục account: ổn cho phase 1. Production lớn hơn có thể chuyển Postgres sau.

---

## Lưu ý an toàn

- Chỉ dùng OAuth + Graph — **không** cookie/list token scrape  
- Giữ `TOKEN_ENCRYPTION_KEY` bí mật; đổi key = không decrypt được token cũ  
- Không commit file `.env` / `data/app.db`  
- Token hết hạn / checkpoint → **Connect Facebook** lại nick đó  

---

## Phase tiếp theo (chưa code)

- `POST /api/posts` — đăng text/ảnh lên nhiều page  
- Job queue + delay  
- Lịch đăng + log `post_id`
