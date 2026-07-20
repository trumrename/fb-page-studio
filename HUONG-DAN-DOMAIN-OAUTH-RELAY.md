# Hướng dẫn chi tiết — Domain cho OAuth Relay

Mục tiêu: **1 domain HTTPS** chỉ để Facebook gọi lại sau khi login.  
Máy khách vẫn dùng **EXE**, ảnh **local**, **không Ngrok** từng máy.

```text
Facebook
   → https://oauth.TEN-MIEN-ANH.com/auth/facebook/callback
   → Relay (VPS của anh)
   → http://127.0.0.1:3847/...  (EXE trên máy vừa bấm Connect)
```

---

## 0. Anh cần chuẩn bị

| Thứ | Ghi chú |
|-----|---------|
| **Domain** | Đã mua (Namecheap, Cloudflare, GoDaddy, nhà VN…) |
| **VPS hoặc PC 24/7** | IP public, Ubuntu 20/22 khuyến nghị |
| **Meta App** | App ID + App Secret (developers.facebook.com) |
| **Code** | Project fb-page-studio (thư mục `oauth-relay/`) |

**Tên subdomain gợi ý** (chọn 1, ghi nhớ):

```text
oauth.tencongty.com
login.tencongty.com
fbauth.tencongty.com
```

Dưới đây dùng ví dụ:

```text
oauth.tencongty.com
```

Anh thay bằng domain thật của mình **mọi chỗ**.

---

## 1. DNS — trỏ domain về server

### 1.1 Lấy IP VPS

Trên VPS:

```bash
curl -4 ifconfig.me
```

Hoặc xem panel nhà cung cấp (DigitalOcean, AWS Lightsail, Contabo…).

Ghi lại, ví dụ: `203.0.113.10`

### 1.2 Vào trang quản lý DNS domain

Tạo bản ghi:

| Type | Name / Host | Value / Points to | TTL |
|------|-------------|-------------------|-----|
| **A** | `oauth` | `203.0.113.10` | Auto / 300 |

Kết quả FQDN: `oauth.tencongty.com` → IP VPS.

**Lưu ý Cloudflare:**

- Có thể bật **Proxy (đám mây cam)** hoặc **DNS only (xám)**.  
- Lần đầu cấu hình SSL: dễ hơn nếu **DNS only**, xong Let’s Encrypt rồi bật proxy nếu muốn.  
- Nếu dùng **Full (strict)** SSL trên Cloudflare: cần cert hợp lệ trên origin (Nginx).

### 1.3 Kiểm tra DNS đã lan

Trên máy Windows (PowerShell):

```powershell
nslookup oauth.tencongty.com
```

Hoặc:

```powershell
Resolve-DnsName oauth.tencongty.com -Type A
```

Phải thấy IP VPS. DNS có thể chậm **vài phút → vài giờ**.

---

## 2. Cài phần mềm trên VPS (Ubuntu)

SSH vào VPS:

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx git curl
```

### Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v20.x
```

### Code relay

```bash
# Cách 1: clone cả repo
cd /opt
sudo git clone https://github.com/trumrename/fb-page-studio.git
sudo chown -R $USER:$USER /opt/fb-page-studio
cd /opt/fb-page-studio

# Cách 2: chỉ cần thư mục oauth-relay + package không bắt buộc
# (relay server.mjs thuần Node, không cần npm install)
```

Relay dùng Node built-in `http` + `fetch` (Node 18+) — **không bắt buộc** `npm install` cho riêng relay.

---

## 3. File cấu hình relay (có SECRET — chỉ trên VPS)

```bash
cd /opt/fb-page-studio
nano oauth-relay/.env
```

Nội dung mẫu:

```env
# Cổng nội bộ (Nginx proxy vào đây)
PORT=8080
LISTEN_HOST=127.0.0.1

# Domain public (HTTPS) — phải khớp DNS + Meta
RELAY_PUBLIC_URL=https://oauth.tencongty.com
FB_REDIRECT_URI=https://oauth.tencongty.com/auth/facebook/callback

# Gói KHÁCH: secret CHỈ ở đây
RELAY_EXCHANGE=1
FB_APP_ID=DÁN_APP_ID_META
FB_APP_SECRET=DÁN_APP_SECRET_META

FB_GRAPH_VERSION=v21.0
DEFAULT_LOCAL_PORT=3847
```

**Khớp tuyệt đối:**

- `RELAY_PUBLIC_URL` host = `oauth.tencongty.com`
- `FB_REDIRECT_URI` = `https://oauth.tencongty.com/auth/facebook/callback`  
  (có `https://`, path `/auth/facebook/callback`, **không** slash thừa cuối nếu Meta không có)

Lưu file (`Ctrl+O`, Enter, `Ctrl+X`).

Quyền file (tránh lộ):

```bash
chmod 600 oauth-relay/.env
```

---

## 4. Nginx — HTTP trước, rồi HTTPS

### 4.1 Site tạm (HTTP) để Certbot

```bash
sudo nano /etc/nginx/sites-available/oauth-relay
```

```nginx
server {
    listen 80;
    server_name oauth.tencongty.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Bật site:

```bash
sudo ln -sf /etc/nginx/sites-available/oauth-relay /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 4.2 Chạy relay thử

```bash
cd /opt/fb-page-studio
node oauth-relay/server.mjs
```

Log mong đợi:

```text
OAuth Relay  127.0.0.1:8080
Mode         EXCHANGE (customer-safe)
```

Cửa sổ khác:

```bash
curl -s http://127.0.0.1:8080/health
# {"ok":true,"service":"fb-page-studio-oauth-relay","exchange":true}
```

### 4.3 Chứng chỉ HTTPS (Let’s Encrypt)

```bash
sudo certbot --nginx -d oauth.tencongty.com
```

Làm theo hướng dẫn (email, đồng ý ToS). Certbot tự sửa Nginx thêm `listen 443 ssl`.

Kiểm tra:

```bash
curl -sI https://oauth.tencongty.com/health
curl -s https://oauth.tencongty.com/health
```

Phải `HTTP/2 200` hoặc `HTTP/1.1 200` và JSON `ok`.

### 4.4 Chạy relay nền (pm2)

```bash
sudo npm i -g pm2
cd /opt/fb-page-studio
pm2 start oauth-relay/server.mjs --name oauth-relay
pm2 save
pm2 startup
# chạy lệnh pm2 startup gợi ý (copy-paste)
```

Xem log:

```bash
pm2 logs oauth-relay
```

---

## 5. Meta for Developers — gắn domain

1. Vào [developers.facebook.com](https://developers.facebook.com) → App của anh.  
2. **Facebook Login** → **Settings** (hoặc sản phẩm Facebook Login).  
3. **Valid OAuth Redirect URIs** → **Add URI**:

```text
https://oauth.tencongty.com/auth/facebook/callback
```

4. **Save Changes**.  
5. **App settings → Basic**: ghi **App ID**, **App Secret** (đã dán vào relay `.env`).  
6. **Roles**: nick sẽ Connect phải là Developer/Tester nếu App chưa Live.  
7. (Khuyến nghị) App có icon + category để tránh “Feature unavailable”.

**Sai thường gặp:**

| Sai | Đúng |
|-----|------|
| `http://...` | `https://...` |
| `.../callback/` (slash thừa) | `.../callback` (khớp file `.env`) |
| Domain Ngrok máy khác | Đúng domain relay |
| `www.oauth...` trong DNS nhưng Meta không www | Thống nhất có/không `www` |

---

## 6. Gói EXE — trỏ cùng domain

### 6.1 Máy admin (để pack)

Trong `.env` máy build (hoặc khi pack đọc được):

```env
FB_APP_ID=...
FB_APP_SECRET=...
FB_REDIRECT_URI=https://oauth.tencongty.com/auth/facebook/callback
OAUTH_RELAY_URL=https://oauth.tencongty.com
```

```powershell
cd D:\fb-page-poster
npm run pack:both
```

### 6.2 Gói nội bộ (`pack-internal`)

- Đã có secret trong `.env`  
- `OAUTH_RELAY=1`, `FB_REDIRECT_URI=https://oauth.tencongty.com/...`  
- Copy cho NV tin cậy → mở EXE → Connect  

### 6.3 Gói khách (`pack-customer`)

File `.env.public` (không secret) dạng:

```env
PORT=3847
APP_BASE_URL=http://127.0.0.1:3847
OAUTH_RELAY=1
NGROK_AUTOSTART=0
OAUTH_RELAY_URL=https://oauth.tencongty.com
FB_REDIRECT_URI=https://oauth.tencongty.com/auth/facebook/callback
FB_APP_ID=...chỉ App ID...
TOKEN_ENCRYPTION_KEY=
```

Khách: mở EXE (tự tạo `.env` từ `.env.public`) → Connect.  
**App Secret không nằm trên máy khách** — chỉ trên relay.

---

## 7. Kiểm thử end-to-end

| # | Việc | Kết quả mong đợi |
|---|------|------------------|
| 1 | `nslookup oauth.tencongty.com` | IP VPS |
| 2 | `https://oauth.tencongty.com/health` | `{"ok":true,...}` |
| 3 | `https://oauth.tencongty.com/` | Trang “OAuth Relay”, mode EXCHANGE |
| 4 | Meta đã lưu Redirect URI | Không báo URL blocked |
| 5 | Mở EXE, **giữ app mở** | Port 3847 listen |
| 6 | Connect Facebook | Chrome login + 2FA |
| 7 | Sau approve | Về app, thấy account/page |

**Lỗi thường gặp:**

| Hiện tượng | Nguyên nhân / xử lý |
|------------|---------------------|
| `URL Blocked` Meta | Redirect URI Meta ≠ `.env` / relay |
| Trắng / không về app | EXE **tắt** lúc callback; mở lại Connect |
| `Ticket hết hạn` | Claim quá 2 phút; Connect lại |
| Relay 500 exchange | Sai App Secret / sai redirect_uri khi đổi code |
| DNS không ra | Chờ TTL / sai bản ghi A |
| SSL lỗi | Certbot lại; Cloudflare SSL mode |

---

## 8. Firewall VPS

```bash
# UFW ví dụ
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

**Không** mở 8080 ra internet nếu Nginx đã proxy (chỉ `127.0.0.1:8080`).

---

## 9. Sơ đồ tổng

```text
                    ┌─────────────────────────────┐
  DNS A             │  VPS                         │
  oauth.tencongty.com──►│  Nginx :443 (HTTPS)           │
                    │       │ proxy                 │
                    │       ▼                       │
                    │  oauth-relay :8080            │
                    │  + FB_APP_SECRET              │
                    │  RELAY_EXCHANGE=1             │
                    └─────────────┬───────────────┘
                                  │ 302 ticket
                                  ▼
                    ┌─────────────────────────────┐
                    │  Máy khách (mọi PC)         │
                    │  EXE :3847                  │
                    │  APP_BASE_URL=127.0.0.1     │
                    │  Ảnh: D:\folder local       │
                    └─────────────────────────────┘
```

---

## 10. Checklist in ra dán bàn

- [ ] Domain `oauth.…` bản ghi **A** → IP VPS  
- [ ] `nslookup` đúng IP  
- [ ] Nginx + Certbot HTTPS OK  
- [ ] `curl https://oauth.…/health` → ok  
- [ ] `oauth-relay/.env`: EXCHANGE=1, App ID/Secret, Redirect URI  
- [ ] pm2 `oauth-relay` online  
- [ ] Meta Valid OAuth Redirect URI **y hệt**  
- [ ] pack-internal / pack-customer trỏ cùng domain  
- [ ] Thử Connect 1 máy EXE  

---

## 11. Tài liệu liên quan trong project

| File | Nội dung |
|------|----------|
| `HUONG-DAN-OAUTH-RELAY.md` | Relay + EXE |
| `HAI-GOI-NOI-BO-VA-KHACH.md` | pack-internal vs pack-customer |
| `oauth-relay/.env.example` | Mẫu secret relay |
| `oauth-relay/server.mjs` | Code relay |

---

**Tóm lại:** Domain = **một subdomain HTTPS** → DNS về VPS → Nginx → relay → Meta **một** URI.  
Khách không đụng domain; chỉ mở EXE và Connect.

Khi anh đã có tên domain + IP VPS, có thể thay `oauth.tencongty.com` trong file này bằng domain thật và làm từng bước theo checklist mục 10.
