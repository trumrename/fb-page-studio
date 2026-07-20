# Domain OAuth trên máy treo nhà (không VPS)

Domain: **`videoviral1.chainityai.com`**  
Máy: Windows bật 24/7 (máy “server” của anh)  
Khách: EXE local, **không** Ngrok từng máy

---

## Cài nhanh (script tự động)

Trên **máy server treo**:

1. Copy cả folder project `fb-page-poster` sang máy đó (hoặc git clone).  
2. Chuột phải **`CAI-MAY-SERVER.bat`** → **Run as administrator** (nên).  
3. Điền khi hỏi: `FB_APP_ID`, `FB_APP_SECRET` (domain mặc định đã là `videoviral1.chainityai.com`).  
4. Đồng ý `cloudflared tunnel login` → chọn zone **chainityai.com**.  
5. Xong → mỗi ngày / sau reboot chỉ bấm **`CHAY-SERVER-TAT-CA.bat`**.  
6. Meta: thêm Redirect URI  
   `https://videoviral1.chainityai.com/auth/facebook/callback`  
7. Máy dev: `npm run pack:both` rồi giao EXE.

Script nằm ở: `server-setup\install-server.ps1` · `CAI-MAY-SERVER.bat` · `CHAY-SERVER-TAT-CA.bat`

```text
Facebook → https://videoviral1.chainityai.com/.../callback
        → máy treo nhà (relay)
        → http://127.0.0.1:3847  (EXE trên máy vừa Connect)
```

---

## Nên chọn cách nào?

| Cách | Ưu | Nhược |
|------|----|--------|
| **A. Cloudflare Tunnel** (khuyến nghị nhà) | Không mở port router, IP đổi cũng được, HTTPS sẵn | Cần domain trên Cloudflare (hoặc CNAME) |
| **B. Port forward 80/443** | Cổ điển | IP nhà đổi; CGNAT (nhiều FPT/VNPT) **không** vào từ ngoài; phải lo SSL |

**Làm A nếu được.** Dưới đây chi tiết **A**, rồi tóm **B**.

---

# CÁCH A — Cloudflare Tunnel (khuyên dùng)

## A1. Điều kiện

1. Domain `chainityai.com` đang (hoặc chuyển) DNS về **Cloudflare** (free plan được).  
2. Máy Windows treo: cài Node + project (hoặc chỉ `oauth-relay`).  
3. Tài khoản Cloudflare free.

## A2. DNS: không cần trỏ A về IP nhà

Với Tunnel, Cloudflare tự tạo route — **không** bắt buộc mở port modem.

## A3. Cài relay trên máy treo (Windows)

### 1) Mở PowerShell **Admin** (tuỳ chọn) hoặc thường

```powershell
cd D:\fb-page-poster
```

(Nếu code ở ổ khác, `cd` đúng path.)

### 2) File `oauth-relay\.env`

Tạo file:

`D:\fb-page-poster\oauth-relay\.env`

```env
PORT=8080
LISTEN_HOST=127.0.0.1

RELAY_PUBLIC_URL=https://videoviral1.chainityai.com
FB_REDIRECT_URI=https://videoviral1.chainityai.com/auth/facebook/callback

RELAY_EXCHANGE=1
FB_APP_ID=DÁN_APP_ID
FB_APP_SECRET=DÁN_APP_SECRET

FB_GRAPH_VERSION=v21.0
DEFAULT_LOCAL_PORT=3847
```

Chỉ anh biết file này. Không đưa khách.

### 3) Chạy thử relay

```powershell
cd D:\fb-page-poster
node oauth-relay\server.mjs
```

Thấy:

```text
OAuth Relay  127.0.0.1:8080
Mode         EXCHANGE
```

Cửa sổ khác:

```powershell
curl http://127.0.0.1:8080/health
```

→ `"ok":true`

Giữ cửa sổ relay chạy (hoặc dùng NSSM/pm2 ở bước A5).

## A4. Cài Cloudflare Tunnel (`cloudflared`)

### 1) Tải

https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/

Hoặc winget:

```powershell
winget install --id Cloudflare.cloudflared -e
```

### 2) Đăng nhập

```powershell
cloudflared tunnel login
```

Mở browser → chọn domain **chainityai.com** → Authorize.

### 3) Tạo tunnel

```powershell
cloudflared tunnel create fb-oauth-relay
```

Ghi **Tunnel ID** (chuỗi UUID) in ra.

File credentials thường nằm:

```text
C:\Users\TÊN_ANH\.cloudflared\<TUNNEL-ID>.json
```

### 4) File config tunnel

Tạo (sửa path credentials và user):

`C:\Users\TÊN_ANH\.cloudflared\config.yml`

```yaml
tunnel: fb-oauth-relay
credentials-file: C:\Users\TÊN_ANH\.cloudflared\THAY_BANG_TUNNEL_ID.json

ingress:
  - hostname: videoviral1.chainityai.com
    service: http://127.0.0.1:8080
  - service: http_status:404
```

### 5) Trỏ DNS vào tunnel

```powershell
cloudflared tunnel route dns fb-oauth-relay videoviral1.chainityai.com
```

Cloudflare tạo CNAME `videoviral1` → tunnel (HTTPS public tự có).

### 6) Chạy tunnel

```powershell
cloudflared tunnel run fb-oauth-relay
```

### 7) Kiểm tra

Trình duyệt / máy khác:

```text
https://videoviral1.chainityai.com/health
https://videoviral1.chainityai.com/
```

Phải ra JSON / trang OAuth Relay.

**Hai process phải cùng bật trên máy treo:**

1. `node oauth-relay\server.mjs` (port 8080)  
2. `cloudflared tunnel run fb-oauth-relay`

## A5. Chạy tự động khi Windows mở (máy treo)

### Cách đơn giản: 2 file `.bat` + Startup

**`D:\fb-page-poster\CHAY-OAUTH-RELAY.bat`**

```bat
@echo off
cd /d D:\fb-page-poster
node oauth-relay\server.mjs
pause
```

**`D:\fb-page-poster\CHAY-CLOUDFLARED.bat`**

```bat
@echo off
cloudflared tunnel run fb-oauth-relay
pause
```

Win+R → `shell:startup` → tạo shortcut 2 file bat vào Startup  
(hoặc Task Scheduler: “At logon”, Run whether user logged on — cần cấu hình mật khẩu).

### Cách ổn hơn: NSSM / WinSW (service Windows)

Cài NSSM → 2 service: `oauth-relay` và `cloudflared`.  
(Máy reboot vẫn chạy, không cần login desktop nếu cấu hình service đúng.)

---

# CÁCH B — Port forward (nếu không dùng Cloudflare Tunnel)

Chỉ làm khi:

- Nhà có **IP public thật** (không CGNAT)  
- Anh mở được port trên modem  

### B1. DNS

| Type | Name | Value |
|------|------|--------|
| A | `videoviral1` | **IP public nhà** (https://whatismyip.com) |

IP nhà đổi → phải sửa DNS (hoặc dùng DDNS).

### B2. Modem / router

Port forwarding:

| Ngoài | Trong | IP LAN máy treo |
|-------|-------|-----------------|
| TCP 80 | 80 | 192.168.x.x |
| TCP 443 | 443 | 192.168.x.x |

Máy treo: IP LAN **cố định** (DHCP reservation).

### B3. SSL trên Windows

Phức tạp hơn Linux. Gợi ý:

- **win-acme** (Let's Encrypt) + reverse proxy, hoặc  
- Chạy **Caddy** / **nginx for Windows** terminate HTTPS → `127.0.0.1:8080`

Hoặc **chỉ Tunnel (cách A)** cho đỡ đau.

### B4. Relay vẫn:

```env
LISTEN_HOST=127.0.0.1
PORT=8080
```

Proxy public 443 → 8080. **Không** expose 8080 ra internet trực tiếp nếu có thể.

---

# Meta (cả cách A và B)

Valid OAuth Redirect URIs:

```text
https://videoviral1.chainityai.com/auth/facebook/callback
```

Save. App ID/Secret = file `oauth-relay\.env` trên **máy treo**.

---

# Pack EXE (máy admin — có thể cùng máy treo)

```powershell
cd D:\fb-page-poster
```

Trong `.env` project:

```env
FB_REDIRECT_URI=https://videoviral1.chainityai.com/auth/facebook/callback
OAUTH_RELAY_URL=https://videoviral1.chainityai.com
FB_APP_ID=...
FB_APP_SECRET=...
```

```powershell
npm run build:desktop
npm run pack:both
```

| Gói | Dùng cho |
|-----|----------|
| `pack-internal\` | Máy tin cậy (có secret) |
| `pack-customer\` | Khách (không secret) |

---

# Thứ tự bật máy treo mỗi ngày / sau reboot

1. Internet ổn  
2. **oauth-relay** (Node)  
3. **cloudflared** (nếu cách A)  
4. (Tuỳ) pack/build — không bắt buộc 24/7  

Kiểm tra: https://videoviral1.chainityai.com/health  

Máy khách: mở EXE → Connect (app khách **đang mở**).

---

# Checklist máy nhà

- [ ] Relay `.env` đúng domain + App Secret  
- [ ] `curl http://127.0.0.1:8080/health` OK  
- [ ] Cloudflare Tunnel **hoặc** port forward + HTTPS  
- [ ] https://videoviral1.chainityai.com/health OK từ điện thoại 4G  
- [ ] Meta Redirect URI đúng  
- [ ] Relay + tunnel tự chạy khi bật máy  
- [ ] Thử Connect 1 EXE  

**Thử từ 4G (không WiFi nhà):** nếu health OK → domain vào được máy treo từ ngoài.

---

# Lỗi hay gặp ở nhà

| Lỗi | Xử lý |
|-----|--------|
| Health OK trong nhà, 4G không vào | CGNAT / chưa port forward → dùng **Cloudflare Tunnel** |
| Tunnel chạy nhưng 502 | Relay Node **chưa** bật trên 8080 |
| IP nhà đổi (cách B) | Sửa DNS A hoặc DDNS |
| Ngủ máy / Hibernate | Tắt sleep: Power Options → Never sleep |
| Connect không về app | EXE khách tắt; hoặc relay/tunnel chết |

---

# Tóm một câu

**Máy treo nhà = VPS mini:** chạy **relay + (Cloudflare Tunnel khuyến nghị)**; domain `videoviral1.chainityai.com` trỏ vào đó; khách chỉ EXE + Connect.

Làm lần lượt: **relay local → Tunnel → health từ 4G → Meta → pack:both → Connect thử.**
