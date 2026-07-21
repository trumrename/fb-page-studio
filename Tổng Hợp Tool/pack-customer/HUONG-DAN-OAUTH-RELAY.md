# OAuth Relay — EXE local, bỏ Ngrok từng máy

## Vấn đề anh mô tả

- Máy khách vẫn dùng **app EXE**.
- Ảnh / caption vẫn **folder local**.
- Không muốn Ngrok: **ngắt máy cũ → bật máy mới** (domain bận, phức tạp).

## Giải pháp

**1 domain nhỏ chỉ làm “trạm chuyển” OAuth** (relay).  
Không đăng bài, không lưu ảnh, không lưu token.

```text
[Máy khách EXE đang mở]
  → Chrome: đăng nhập Facebook
  → Facebook gọi: https://oauth.ten-mien-anh.com/auth/facebook/callback?code=...
  → Relay 302 → http://127.0.0.1:3847/auth/facebook/callback?code=...
  → EXE trên máy khách nhận code, đổi token, xong
```

Nhiều máy cùng lúc: **mỗi máy** browser redirect về **127.0.0.1 của máy đó** → không tranh domain Ngrok.

---

## Phần 1 — Server relay (chỉ 1 lần, máy anh / VPS)

### 1. Domain + SSL

Ví dụ: `oauth.ten-mien-anh.com` → IP VPS.

### 2. Chạy relay

```bash
cd fb-page-studio
# PORT public phía sau Nginx
PORT=8080 RELAY_PUBLIC_URL=https://oauth.ten-mien-anh.com node oauth-relay/server.mjs
```

Hoặc pm2:

```bash
pm2 start oauth-relay/server.mjs --name oauth-relay --update-env -- \
  # env trong ecosystem
```

### 3. Nginx

```nginx
server {
  listen 443 ssl http2;
  server_name oauth.ten-mien-anh.com;
  # ssl_certificate ...;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

### 4. Meta App

Valid OAuth Redirect URIs **một dòng**:

```text
https://oauth.ten-mien-anh.com/auth/facebook/callback
```

(Đúng từng ký tự với `FB_REDIRECT_URI` trên mọi máy khách.)

---

## Phần 2 — Máy khách (EXE)

1. Cài / copy EXE như bình thường.  
2. `.env` cạnh EXE — mẫu: `.env.customer-relay.example`

```env
OAUTH_RELAY=1
NGROK_AUTOSTART=0
APP_BASE_URL=http://127.0.0.1:3847
FB_REDIRECT_URI=https://oauth.ten-mien-anh.com/auth/facebook/callback
FB_APP_ID=...
FB_APP_SECRET=...
TOKEN_ENCRYPTION_KEY=...
```

3. Mở EXE → **Connect Facebook** (giữ app mở).  
4. Login FB + 2FA → tự về app.  
5. Folder media **local** như cũ.

**Không** dán Ngrok token, **không** bật tunnel, **không** ngắt máy khác.

---

## Phần 3 — So sánh

| | Ngrok mỗi máy | OAuth relay |
|--|---------------|-------------|
| EXE + folder local | Có | Có |
| Ngrok máy khách | Có | **Không** |
| Đổi máy Connect | Domain busy / ngắt cũ | **Song song được** |
| Server anh phải chạy | Không | Relay nhỏ 24/7 |
| Upload ảnh server | Không | Không |

---

## Phần 4 — Lưu ý

- Connect: **app EXE phải đang chạy** trên máy đó (port 3847).  
- State OAuth có dạng `….3847` để relay biết port.  
- Relay **không** thay server đăng bài trung tâm; chỉ bỏ Ngrok cho login.  
- App Secret vẫn nằm `.env` máy khách (như portable hiện tại).

---

## Kiểm tra

```bash
# Relay
curl -sI "https://oauth.ten-mien-anh.com/health"

# Mô phỏng redirect (cần app đang listen 3847)
# Browser: Facebook → callback relay → 127.0.0.1:3847
```

Trên EXE, `/api/deploy` có `"oauth_relay": true` khi `OAUTH_RELAY=1`.
