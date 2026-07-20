# Báo cáo kiểm tra pack-server + pack-internal

**Ngày:** 2026-07-20  
**Lệnh rebuild:** `npm run pack:server` · `npm run pack:internal`

---

## 1. Kết luận

| Gói | Trạng thái | Ghi chú |
|-----|------------|---------|
| **pack-server** | **OK dùng được** | Đủ file, PS1 parse OK, relay chạy smoke |
| **pack-internal** | **OK dùng được** | Có EXE + `.env` secret; domain đã khớp server |

**Đã sửa trong lần check này:**

1. Domain nội bộ lệch `qgroup.ngrok.app` vs server `videoviral1...` → **đã ép pack-internal về `videoviral1.chainityai.com`**  
2. Bat `CHAY-SERVER-TAT-CA` quote path → **đã sửa**  
3. Script cài: xử lý **cert.pem** Cloudflare + `FIX-CLOUDFLARE-CERT.bat`

---

## 2. pack-server (máy treo OAuth)

### File bắt buộc — đủ

| File | Vai trò |
|------|---------|
| `oauth-relay/server.mjs` | Relay |
| `oauth-relay/.env.example` | Mẫu (secret trống) |
| `CAI-MAY-SERVER.bat` | Cài 1 lần |
| `install-server.ps1` | Logic cài (PARSE_OK) |
| `CHAY-SERVER-TAT-CA.bat` | Chạy relay + tunnel |
| `CHAY-RELAY-ONLY.bat` | Chỉ relay |
| `FIX-CLOUDFLARE-CERT.bat` | Sửa thiếu cert.pem |
| `README.txt` | Hướng dẫn |

### Không có (đúng thiết kế)

- Không EXE app  
- Không `.env` secret sẵn (tạo khi CAI)  
- Không `node_modules` (relay dùng Node built-in)

### Domain mẫu

```text
https://videoviral1.chainityai.com
https://videoviral1.chainityai.com/auth/facebook/callback
```

### Smoke test

- `node oauth-relay/server.mjs` + `/health` → `ok`, `exchange=true`  
- Mode redirect forward callback OK  

### Copy sang máy server

Dùng zip:

```text
D:\fb-page-poster\FB-Page-Studio-pack-server.zip
```

Giải nén → **phải thấy** `pack-server\oauth-relay\server.mjs`.  
Thiếu folder `oauth-relay` = lỗi “Missing server.mjs” như trước.

---

## 3. pack-internal (EXE nội bộ)

### File

| File | Trạng thái |
|------|------------|
| `FB-Page-Studio-Desktop-v1.2.22.exe` | OK (~97 MB) |
| `.sha256.txt` | OK |
| `.env` | OK — **có secret** |
| `README-NOI-BO.txt` | OK |
| `VERSION.txt` / `MANIFEST.txt` | OK |

### `.env` nội bộ (đã kiểm tra logic)

| Key | Trạng thái |
|-----|------------|
| `OAUTH_RELAY=1` | OK |
| `NGROK_AUTOSTART=0` | OK |
| `APP_BASE_URL=http://127.0.0.1:3847` | OK |
| `OAUTH_RELAY_URL` | **https://videoviral1.chainityai.com** |
| `FB_REDIRECT_URI` | **…/auth/facebook/callback** (cùng host) |
| `FB_APP_ID` | Có |
| `FB_APP_SECRET` | Có (len>8) |
| `TOKEN_ENCRYPTION_KEY` | Có |

### Cảnh báo đã xử lý

- Trước check: internal trỏ **ngrok** trong khi server trỏ **videoviral1** → Connect lệch domain.  
- Sau rebuild: **đã khớp videoviral1**.

---

## 4. Việc anh còn phải làm (không phải lỗi file)

| Việc | Ai |
|------|-----|
| Domain DNS + Cloudflare account anh | Anh |
| `CAI-MAY-SERVER.bat` + cert.pem tunnel | Máy server |
| Meta whitelist Redirect URI | Anh |
| Copy **đủ** pack-server (có oauth-relay) | Anh |
| Copy pack-internal (máy tin cậy) | Anh |

Chưa xong Cloudflare `cert.pem` / tunnel = domain chưa public — **không phải pack thiếu file app**.

---

## 5. Cách dùng 2 gói trên máy treo

```text
D:\FB\
  pack-server\     ← gói server (OAuth)
  pack-internal\   ← EXE + .env nội bộ
```

1. Cài/chạy **pack-server** (khi Connect).  
2. Mở EXE trong **pack-internal**.  
3. Connect FB.

---

## 6. Lệnh tạo lại

```powershell
cd D:\fb-page-poster
npm run pack:server
npm run pack:internal
# hoac
npm run pack:server-and-internal
```

Domain pack khác:

```powershell
$env:PACK_OAUTH_DOMAIN="oauth.domain-moi.com"
npm run pack:internal
npm run pack:server
```

---

**Tóm lại:** File server + nội bộ **đủ và parse OK**; domain 2 gói **đã khớp** `videoviral1.chainityai.com`. Copy lại zip/folder mới sang máy server (đủ `oauth-relay`), xử lý Cloudflare cert, Meta URI — rồi dùng.
