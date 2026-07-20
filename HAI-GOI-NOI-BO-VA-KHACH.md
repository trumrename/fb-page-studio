# Hai gói: Nội bộ tin cậy & Khách an toàn

## So sánh

| | **pack-internal** (nội bộ) | **pack-customer** (khách) |
|--|----------------------------|---------------------------|
| Ai dùng | NV / máy tin cậy | Khách ngoài |
| App Secret trên EXE | **Có** (điền sẵn) | **Không** |
| Ngrok | Không | Không |
| OAuth | Relay REDIRECT (code về EXE) hoặc EXCHANGE | Relay **EXCHANGE** (ticket) |
| Ảnh | Folder local | Folder local |
| Khách điền | Gần như không | Đổi `.env.public` → `.env` (đã public sẵn) |
| Public / GitHub | **Cấm** (có secret) | Được (Release) |

---

## 1. Gói nội bộ — `npm run pack:internal`

```powershell
cd D:\fb-page-poster
# .env máy admin đã có FB_APP_ID + SECRET + redirect relay
npm run build:desktop   # nếu chưa có EXE
npm run pack:internal
```

Ra: `pack-internal\`

- `.env` **đầy đủ secret** (lấy từ `.env` admin)
- EXE + README-NOI-BO
- **gitignore** — không commit

Cách dùng: copy folder → mở EXE → Connect FB.

---

## 2. Gói khách — `npm run pack:customer`

```powershell
npm run pack:customer
# hoặc npm run pack:all
```

Ra: `pack-customer\`

- `.env.public` / `.env.example` — **chỉ** App ID + relay URL + `OAUTH_RELAY=1`
- **Không** `FB_APP_SECRET`, không Ngrok token
- README-KHACH: đổi tên `.env.public` → `.env` → mở EXE → Connect

### Relay phía server (bắt buộc cho gói khách)

```env
# oauth-relay/.env trên VPS
RELAY_EXCHANGE=1
FB_APP_ID=...
FB_APP_SECRET=...
RELAY_PUBLIC_URL=https://oauth.ten-mien-anh.com
FB_REDIRECT_URI=https://oauth.ten-mien-anh.com/auth/facebook/callback
```

```bash
npm run start:oauth-relay
```

Meta whitelist **một** redirect URI (domain relay).

---

## 3. APP_BASE_URL

Mọi máy khách (cả hai gói):

```env
APP_BASE_URL=http://127.0.0.1:3847
```

**Giống nhau** — không phải mỗi máy một URL public.

---

## 4. Khách “chỉ mở app Connect”

| Gói | Việc khách |
|-----|------------|
| Nội bộ | Mở EXE (đã có `.env`) → Connect |
| Khách | Copy gói → đổi `.env.public` thành `.env` (1 lần, không secret) → Connect |

Muốn khách **không** đổi tên file: ship sẵn file tên `.env` **chỉ bản public** (không secret) — script khách đã tạo `.env.public`; có thể copy thành `.env` khi zip nếu admin chắc không nhầm secret.

---

## 5. Checklist an toàn gói khách

- [ ] Không có `FB_APP_SECRET=giá_trị`
- [ ] Không có `NGROK_AUTHTOKEN=giá_trị`
- [ ] Không có `keys/license-private.pem`
- [ ] Relay `RELAY_EXCHANGE=1` + secret trên VPS
- [ ] Meta redirect = domain relay
