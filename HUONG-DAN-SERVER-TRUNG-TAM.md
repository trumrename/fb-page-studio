# Hướng dẫn Server trung tâm (domain riêng)

Khách **không** cài server, **không** Ngrok trên máy họ.  
Chỉ mở trình duyệt → domain của anh → Connect Facebook → upload ảnh → đăng.

---

## 1. Kiến trúc

```text
Facebook  →  https://app.ten-mien-anh.com/.../callback  →  Server của anh
Trình duyệt khách  →  https://app.ten-mien-anh.com/app.html  →  Server
Máy khách chọn ảnh  →  Upload API  →  data/media/inbox trên server  →  Graph API
```

| Thành phần | Máy server | Máy khách |
|------------|------------|-----------|
| Node + app | Có | Không |
| Domain + SSL | Có | Không |
| Ngrok | Không (thường) | Không |
| Mở web | Quản trị | Có |
| Ảnh | Lưu `data/media` | Upload qua web |

---

## 2. Chuẩn bị domain

1. Mua domain (Cloudflare / nhà cung cấp bất kỳ).  
2. DNS **A** (hoặc AAAA) trỏ về IP VPS.  
3. SSL: Nginx + Let's Encrypt, hoặc Cloudflare proxy.

**Meta for Developers** → Valid OAuth Redirect URIs:

```text
https://app.ten-mien-anh.com/auth/facebook/callback
```

(Trùng `FB_REDIRECT_URI` trong `.env`.)

---

## 3. Cài trên VPS (Ubuntu ví dụ)

```bash
# Node 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git nginx

git clone https://github.com/trumrename/fb-page-studio.git
cd fb-page-studio
npm install

cp .env.central.example .env
nano .env   # điền domain, FB_APP_*, TOKEN_ENCRYPTION_KEY, CENTRAL_ACCESS_TOKEN
```

Chạy thử:

```bash
export DEPLOY_MODE=central
npm start
# mở http://IP:3847/app.html  (sau Nginx thì dùng https domain)
```

Chạy nền (pm2):

```bash
sudo npm i -g pm2
DEPLOY_MODE=central pm2 start src/server.js --name fb-page-studio
pm2 save && pm2 startup
```

---

## 4. Nginx (HTTPS)

```nginx
server {
  listen 443 ssl http2;
  server_name app.ten-mien-anh.com;

  # ssl_certificate ...;

  client_max_body_size 100m;

  location / {
    proxy_pass http://127.0.0.1:3847;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

`.env` server:

```env
DEPLOY_MODE=central
LISTEN_HOST=127.0.0.1
TRUST_PROXY_HOPS=1
APP_BASE_URL=https://app.ten-mien-anh.com
FB_REDIRECT_URI=https://app.ten-mien-anh.com/auth/facebook/callback
NGROK_AUTOSTART=0
```

(`LISTEN_HOST=127.0.0.1` nếu chỉ Nginx local; `0.0.0.0` nếu không proxy.)

---

## 5. Việc khách làm

1. Mở `https://app.ten-mien-anh.com/app.html`  
2. Nếu có mã: nhập `CENTRAL_ACCESS_TOKEN`  
3. **Connect Facebook** (OAuth về domain anh)  
4. **Publish** → Upload ảnh/video/caption  
5. **Dùng folder server cho Page** → cấu hình → chạy đăng / hẹn giờ  

Không cài EXE server, không Ngrok, không `.env` trên máy khách.

---

## 6. Biến môi trường quan trọng

| Biến | Ý nghĩa |
|------|---------|
| `DEPLOY_MODE=central` | Bật server trung tâm |
| `APP_BASE_URL` | Domain HTTPS |
| `FB_REDIRECT_URI` | Callback Meta (cùng host) |
| `NGROK_AUTOSTART=0` | Không bật Ngrok |
| `CENTRAL_ACCESS_TOKEN` | Mã khóa web (khuyến nghị) |
| `TOKEN_ENCRYPTION_KEY` | Mã hóa token FB trong DB |
| `ALLOW_MEDIA_UPLOAD=1` | (central mặc định đã cho upload) |

---

## 7. Portable vs Central

| | Portable (EXE) | Central |
|--|----------------|---------|
| `DEPLOY_MODE` | `portable` (mặc định) | `central` |
| Khách | Cài EXE + Ngrok/domain máy | Chỉ trình duyệt |
| Ảnh | Folder local máy khách | Upload lên server |
| OAuth | Ngrok/domain từng máy | 1 domain server |

Hai chế độ **cùng codebase**. Máy dev vẫn chạy portable bình thường.

---

## 8. Bảo mật

- Bắt buộc HTTPS.  
- `CENTRAL_ACCESS_TOKEN` mạnh.  
- `TOKEN_ENCRYPTION_KEY` ngẫu nhiên, backup an toàn.  
- Firewall: chỉ 80/443 public; 3847 chỉ localhost nếu có Nginx.  
- Backup thư mục `data/` định kỳ (DB + media + license).

---

## 9. Kiểm tra nhanh

```bash
curl -s http://127.0.0.1:3847/api/deploy
# "central": true

curl -s -H "Host: app.ten-mien-anh.com" http://127.0.0.1:3847/api/health
# ok khi domain nằm trong APP_BASE_URL
```

Trên web: banner **SERVER TRUNG TÂM** + panel **Upload media**.
