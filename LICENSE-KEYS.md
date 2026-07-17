# License keys — cấp key cho khách / nhân viên

## Mục tiêu

- Bán tool hoặc cho **nhân viên** dùng có kiểm soát  
- Trial khi tải về chưa mua  
- **Giảm** copy key lung tung / crack nghiệp dư  

> **Thành thật:** app desktop offline **không thể chống crack 100%**.  
> Key ký số + trial + giới hạn = đủ cho thương mại nhỏ / nội bộ.  
> Muốn chặt hơn sau này: server online kiểm tra / revoke key.

---

## Kiến trúc

| Thành phần | Ai giữ | File |
|------------|--------|------|
| **Private key** | Chỉ bạn (máy cấp key) | `keys/license-private.pem` — **không commit, không ship** |
| **Public key** | Trong app mọi máy | `src/services/licensePublicKey.js` |
| **Key user** | Dán vào `/license.html` | Lưu `data/license.json` |

Thuật toán: **Ed25519** sign payload JSON.

---

## Cấp key (máy dev của bạn)

```powershell
cd D:\fb-page-poster

# Nhân viên 90 ngày · 15 account · 50 page
node scripts/gen-license.mjs --type employee --holder "NV-An" --days 90 --max-accounts 15 --max-pages 50

# Khách thương mại 1 năm · unlimited (0 = không giới hạn)
node scripts/gen-license.mjs --type commercial --holder "Cong ty ABC" --email "a@x.com" --days 365 --max-accounts 0 --max-pages 0

# Gắn 1 máy (lấy machine_id từ /license.html của họ)
node scripts/gen-license.mjs --type commercial --holder "Shop1" --days 365 --bind-machine "abc123..."

# Vĩnh viễn
node scripts/gen-license.mjs --type lifetime --holder "VIP" --lifetime
```

File key lưu: `keys/issued/*.txt` (gitignored).

---

## Trường payload

| Field | Ý nghĩa |
|-------|---------|
| `type` | `employee` · `commercial` · `lifetime` · `trial` |
| `holder` | Tên NV / công ty |
| `expires_at` | ISO hết hạn (lifetime = không có) |
| `max_accounts` | 0 = ∞ |
| `max_pages` | 0 = ∞ |
| `machine_id` | `ANY` hoặc HWID 32 hex |

---

## Trial mặc định (chưa có key)

| | |
|--|--|
| Ngày | 7 (`LICENSE_TRIAL_DAYS`) |
| Max account | 2 |
| Max page | 6 |
| Hết trial | Chặn **đăng / hẹn giờ** + Connect account mới |

---

## User kích hoạt

1. Mở app → menu **License**  
2. Copy **Machine ID** gửi bạn (nếu key bind máy)  
3. Dán key → **Kích hoạt**  

---

## Backup quan trọng

- Sao lưu **`keys/license-private.pem`** offline (USB / password manager).  
- Mất private key = **không cấp thêm key** (phải gen keypair mới + update public key trong bản app mới).  
- **Không** đưa private key cho nhân viên / khách.

---

## Roadmap chống abuse (sau)

1. Server `/api/license/check` + blacklist  
2. Heartbeat 24h  
3. Per-seat seat count online  
4. Build obfuscation nhẹ (không thay thế ký số)  
