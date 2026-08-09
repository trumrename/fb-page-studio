# Auto login `id|pass|2fa` + Checkpoint 282

## Nguyên tắc “tiện · ít lỗi”

1. **Ưu tiên cookie** — còn sống thì **không** login lại.  
2. **Profile browser bền** mỗi nick (`data/fb-login-profiles/acc_N`) — giảm “thiết bị lạ”.  
3. **2FA** = secret authenticator (Base32), tool tự sinh mã 30s.  
4. **282 mã email** = không spam login; **chờ mã** (IMAP hoặc dán tay).  
5. Mọi fail = **mã lỗi rõ** (`code` + `message_vi` + `action`).

```
id|pass|2fa
id|pass|2fa|email_nhan_ma_282
```

- `2fa` = **secret key** (vd `JBSWY3DPEHPK3PXP…`), **không** phải mã 6 số.  
- `email` optional — ghi chú hộp thư; IMAP cấu hình riêng.

---

## Cài browser (1 lần)

```bash
cd C:\Users\NCpc\fb-page-poster
npm i playwright
npx playwright install chromium
```

(Tùy chọn đọc mail tự động 282)

```bash
npm i imapflow
```

---

## API

| Method | Path | Việc |
|--------|------|------|
| GET | `/api/http-ops/login/error-catalog` | Bảng mã lỗi |
| POST | `/api/http-ops/login/accounts` | Import 1 nick hoặc `batch_text` |
| GET | `/api/http-ops/login/accounts` | List |
| POST | `/api/http-ops/login/accounts/:id/ensure` | Cookie OK? không thì login |
| POST | `/api/http-ops/login/accounts/:id/login` | Force login |
| POST | `/api/http-ops/login/accounts/:id/submit-282-code` | Dán mã email 282 |
| GET | `/api/http-ops/login/accounts/:id/totp-preview` | Xem mã 2FA hiện tại (debug) |

### Import batch

```http
POST /api/http-ops/login/accounts
{
  "batch_text": "0901234567|MatKhau|JBSWY3DPEHPK3PXP\nuser@gmail.com|Pass2|ABCD..."
}
```

### Ensure (khuyên dùng)

```http
POST /api/http-ops/login/accounts/1/ensure
{ "poll_email": true, "headless": false }
```

- `headless: false` (mặc định) = browser **có UI** (ổn định hơn, có thể minimize).  
- Cookie sống → `{ code: "COOKIE_ALIVE" }` ngay.

### Khi 282 — dán mã từ mail

```http
POST /api/http-ops/login/accounts/1/submit-282-code
{ "code": "123456" }
```

### IMAP (Gmail app password)

```http
POST /api/http-ops/login/accounts
{
  "login_id": "0901...",
  "password": "...",
  "totp_secret": "JBSW...",
  "email_imap": {
    "host": "imap.gmail.com",
    "port": 993,
    "secure": true,
    "user": "you@gmail.com",
    "pass": "xxxx xxxx xxxx xxxx"
  }
}
```

---

## Mã lỗi (rút gọn)

| code | Ý nghĩa | Làm gì |
|------|---------|--------|
| `OK` | Login / cookie xong | Chạy job |
| `COOKIE_ALIVE` | Không cần login | — |
| `BAD_FORMAT` | Sai `id\|pass\|2fa` | Sửa dòng |
| `INVALID_2FA_SECRET` | Dán nhầm mã 6 số | Dán secret |
| `WRONG_PASSWORD` | Sai pass | Đổi pass |
| `NEED_2FA` / `BAD_2FA_CODE` | 2FA | Secret + giờ máy |
| `CHECKPOINT_282` | Cần mã email | Chờ / dán mã |
| `CHECKPOINT_282_CODE_SENT` | Đã gửi mã | Poll mail / dán |
| `CHECKPOINT_282_WAIT_CODE` | Đang chờ | `submit-282-code` |
| `CHECKPOINT_282_BAD_CODE` | Mã sai/hết hạn | Mã mới |
| `CHECKPOINT_282_TIMEOUT` | Chờ quá lâu | Login lại |
| `CHECKPOINT_OTHER` | Selfie / bạn bè… | Login tay 1 lần |
| `CAPTCHA` | Robot | Proxy / tay |
| `DISABLED_ACCOUNT` | Khóa nick | Khôi phục FB |
| `EMAIL_IMAP_FAIL` | IMAP lỗi | App password / dán tay |
| `EMAIL_CODE_NOT_FOUND` | Không thấy mail | Dán tay |
| `BROWSER_NOT_AVAILABLE` | Chưa Playwright | `npm i playwright` |
| `BROWSER_TIMEOUT` | Timeout | Thử lại |
| `NETWORK` / `PROXY_ERROR` | Mạng | Đổi mạng/proxy |
| `UNKNOWN` | Khác | Log + cookie tay |

Full: `GET /api/http-ops/login/error-catalog`

---

## Gỡ 282 (mã về mail) — luồng tiện nhất

```
1. ensure/login → gặp 282
2a. Có IMAP → tool poll ~45s lấy mã → submit tự
2b. Không IMAP → status=wait_282_code
3. User mở mail → copy mã
4. POST submit-282-code
5. Cookie lưu vault → session HTTP
```

**Không** auto “phá” checkpoint selfie/ảnh — báo `CHECKPOINT_OTHER`, user login tay 1 lần trên profile đó.

---

## File code

- `loginErrors.js` — catalog  
- `totp.js` — sinh 2FA  
- `accountLogin.js` — import, ensure, 282  
- `browserLogin.js` — Playwright  
- `emailCodePoll.js` — IMAP optional  
