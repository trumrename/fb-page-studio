# Hướng dẫn domain OAuth — `videoviral1.chainityai.com`

Domain của anh dùng cho **OAuth Relay** (Connect Facebook).  
Máy khách: EXE + ảnh local, **không Ngrok**.

```text
Facebook
  → https://videoviral1.chainityai.com/auth/facebook/callback
  → Relay (VPS)
  → http://127.0.0.1:3847/...  (EXE trên máy vừa Connect)
```

---

## Checklist nhanh

- [ ] DNS A: `videoviral1` → IP VPS  
- [ ] Nginx + HTTPS  
- [ ] Relay `.env` + pm2  
- [ ] Meta Redirect URI  
- [ ] `pack:both` / giao EXE  
- [ ] Thử Connect 1 máy  

---

## Bước 1 — DNS (Cloudflare / nhà domain)

### 1.1 Lấy IP VPS

Trên VPS:

```bash
curl -4 ifconfig.me
echo
```

Ví dụ kết quả: `203.0.113.10` (IP thật của anh).

### 1.2 Tạo bản ghi DNS

Vào DNS zone **chainityai.com**:

| Type | Name | Content / Value | Proxy |
|------|------|-----------------|-------|
| **A** | `videoviral1` | `IP_VPS_CUA_ANH` | Lần đầu: **DNS only** (xám) cho dễ Certbot |

FQDN đầy đủ: **`videoviral1.chainityai.com`**

### 1.3 Kiểm tra máy Windows

```powershell
nslookup videoviral1.chainityai.com
```

Phải ra đúng IP VPS. Chưa ra → chờ 5–30 phút (đôi khi lâu hơn).

---

## Bước 2 — Cài phần mềm trên VPS (Ubuntu)

SSH vào VPS:

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx git curl
```

Node 20:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

Code:

```bash
sudo mkdir -p /opt
cd /opt
# Nếu đã clone rồi thì: cd fb-page-studio && git pull
sudo git clone https://github.com/trumrename/fb-page-studio.git
sudo chown -R $USER:$USER /opt/fb-page-studio
cd /opt/fb-page-studio
```

(Hoặc upload thư mục `oauth-relay` từ máy Windows lên `/opt/fb-page-studio/oauth-relay`.)

---

## Bước 3 — File cấu hình relay (CÓ SECRET)

```bash
cd /opt/fb-page-studio
nano oauth-relay/.env
```

**Dán (điền App ID / Secret của anh):**

```env
PORT=8080
LISTEN_HOST=127.0.0.1

RELAY_PUBLIC_URL=https://videoviral1.chainityai.com
FB_REDIRECT_URI=https://videoviral1.chainityai.com/auth/facebook/callback

# Gói khách: secret CHỈ trên VPS
RELAY_EXCHANGE=1
FB_APP_ID=DÁN_APP_ID_VÀO_ĐÂY
FB_APP_SECRET=DÁN_APP_SECRET_VÀO_ĐÂY

FB_GRAPH_VERSION=v21.0
DEFAULT_LOCAL_PORT=3847
```

Lưu: `Ctrl+O` → Enter → `Ctrl+X`

```bash
chmod 600 oauth-relay/.env
```

**Không** gửi file này cho khách, **không** commit git.

---

## Bước 4 — Chạy relay thử

```bash
cd /opt/fb-page-studio
node oauth-relay/server.mjs
```

Log mong đợi:

```text
OAuth Relay  127.0.0.1:8080
Mode         EXCHANGE (customer-safe)
Public       https://videoviral1.chainityai.com
```

Cửa sổ SSH khác:

```bash
curl -s http://127.0.0.1:8080/health
```

Phải có `"ok":true` và `"exchange":true`.

Tạm `Ctrl+C` dừng, xong Nginx rồi chạy pm2 (bước 6).

---

## Bước 5 — Nginx + HTTPS

### 5.1 File site

```bash
sudo nano /etc/nginx/sites-available/videoviral1-oauth
```

Nội dung **HTTP** (Certbot sẽ thêm SSL):

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name videoviral1.chainityai.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 60s;
    }
}
```

Bật site:

```bash
sudo ln -sf /etc/nginx/sites-available/videoviral1-oauth /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 5.2 Certbot (Let's Encrypt)

**Relay phải đang chạy** (hoặc Certbot chỉ verify HTTP-01 qua Nginx — thường không cần app nếu chỉ lấy cert; vẫn nên bật relay sau).

```bash
# Bật relay nền tạm nếu chưa pm2
cd /opt/fb-page-studio
# terminal khác hoặc:
nohup node oauth-relay/server.mjs > /tmp/oauth-relay.log 2>&1 &

sudo certbot --nginx -d videoviral1.chainityai.com
```

- Email của anh  
- Đồng ý ToS  
- Certbot tự sửa Nginx thêm `443 ssl`

### 5.3 Kiểm tra HTTPS

```bash
curl -sI https://videoviral1.chainityai.com/health
curl -s https://videoviral1.chainityai.com/health
```

Trình duyệt: mở  
https://videoviral1.chainityai.com/  
→ trang “OAuth Relay”, mode **EXCHANGE**.

### 5.4 Cloudflare (nếu dùng)

Sau khi cert xong có thể bật Proxy (cam).  
SSL/TLS mode khuyến nghị: **Full** hoặc **Full (strict)**.

---

## Bước 6 — pm2 (chạy 24/7)

```bash
sudo npm i -g pm2
cd /opt/fb-page-studio

# Tắt process nohup cũ nếu có
pkill -f "oauth-relay/server.mjs" 2>/dev/null || true

pm2 start oauth-relay/server.mjs --name oauth-relay
pm2 save
pm2 startup
# Copy-paste đúng lệnh systemctl mà pm2 in ra, chạy sudo

pm2 status
pm2 logs oauth-relay --lines 30
```

---

## Bước 7 — Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

**Không** cần mở port 8080 ra ngoài (chỉ Nginx → localhost).

---

## Bước 8 — Meta for Developers

1. [developers.facebook.com](https://developers.facebook.com) → App của anh  
2. **Facebook Login** → **Settings**  
3. **Valid OAuth Redirect URIs** → Add:

```text
https://videoviral1.chainityai.com/auth/facebook/callback
```

4. **Save Changes**  
5. Kiểm tra App ID / Secret đã dán đúng `oauth-relay/.env`  
6. **App roles**: nick Connect = Developer/Tester (nếu App Dev mode)  
7. Basic: icon + category (tránh Feature unavailable)

**Phải khớp từng ký tự** với `FB_REDIRECT_URI` trên relay.

---

## Bước 9 — Máy Windows admin: pack EXE

### 9.1 Cập nhật `.env` máy build (admin)

Trong `D:\fb-page-poster\.env` (hoặc App folder) có tối thiểu:

```env
FB_APP_ID=...cùng Meta App...
FB_APP_SECRET=...
FB_REDIRECT_URI=https://videoviral1.chainityai.com/auth/facebook/callback
OAUTH_RELAY_URL=https://videoviral1.chainityai.com
```

### 9.2 Build + 2 gói

```powershell
cd D:\fb-page-poster
npm run build:desktop
npm run pack:both
```

| Gói | Path | Ai dùng |
|-----|------|---------|
| Nội bộ | `pack-internal\` | NV tin cậy (có secret trong `.env`) |
| Khách | `pack-customer\` | Khách (không secret) |

### 9.3 Nội dung gói khách (public)

`.env.public` sẽ gần như:

```env
PORT=3847
APP_BASE_URL=http://127.0.0.1:3847
OAUTH_RELAY=1
NGROK_AUTOSTART=0
OAUTH_RELAY_URL=https://videoviral1.chainityai.com
FB_REDIRECT_URI=https://videoviral1.chainityai.com/auth/facebook/callback
FB_APP_ID=...chỉ ID...
# không có FB_APP_SECRET
TOKEN_ENCRYPTION_KEY=
```

---

## Bước 10 — Thử Connect (máy bất kỳ)

1. VPS: `pm2 status` → `oauth-relay` **online**  
2. Máy test: mở EXE, **để cửa sổ app chạy**  
3. Connect Facebook → login + 2FA → Allow  
4. Browser quay về app local → thấy account / page  
5. Chọn folder ảnh local → đăng thử  

**Hai máy cùng lúc:** mỗi máy Connect riêng — **không** cần ngắt máy kia.

---

## Bảng URL quan trọng (domain anh)

| Mục đích | URL |
|----------|-----|
| Health relay | https://videoviral1.chainityai.com/health |
| Trang relay | https://videoviral1.chainityai.com/ |
| Meta + EXE redirect | https://videoviral1.chainityai.com/auth/facebook/callback |
| App trên máy khách | http://127.0.0.1:3847/app.html |

---

## Lỗi thường gặp với domain này

| Hiện tượng | Xử lý |
|------------|--------|
| `nslookup` không ra IP | Sai DNS Name `videoviral1` / zone `chainityai.com` / chờ TTL |
| Certbot fail | DNS chưa trỏ đúng; tắt Cloudflare proxy tạm |
| `URL Blocked` Meta | Thêm đúng URI callback ở trên, Save |
| Connect xong trắng / lỗi | EXE **tắt** lúc callback → mở lại app rồi Connect |
| Relay 500 exchange | Sai `FB_APP_SECRET` trên **VPS** hoặc redirect_uri lệch |
| Ticket hết hạn | Connect lại trong ~2 phút, app đang mở |

---

## Sơ đồ

```text
DNS: videoviral1.chainityai.com  ──A──►  IP VPS
                                         │
                                    Nginx :443
                                         │
                                    relay :8080  (+ App Secret)
                                         │ 302 + ticket
                                         ▼
                              127.0.0.1:3847  EXE máy khách
                              (ảnh local D:\...)
```

---

**Xong checklist mục đầu file = domain đã xử lý xong.**  
Chi tiết chung thêm: `HUONG-DAN-DOMAIN-OAUTH-RELAY.md` · hai gói: `HAI-GOI-NOI-BO-VA-KHACH.md`.
