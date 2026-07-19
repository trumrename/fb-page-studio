# Admin — Cấp license key

## Bảo mật

| File | Vai trò |
|------|---------|
| `keys/license-private.pem` | **Chỉ admin** — ký key. Không gửi khách, không ship trong EXE |
| `keys/license-public.pem` | Public (đã nhúng trong app) |
| `keys/issued/*.txt` | Lịch sử key đã cấp |

Sao lưu `license-private.pem` ra USB/offline. Mất file này = không cấp key mới khớp app (trừ khi regenerate + rebuild app).

---

## Cách nhanh (Windows)

1. Mở thư mục `Admin-Quan-Ly`
2. Double-click **`MENU-ADMIN.bat`**
3. Chọn:
   - Cấp commercial / employee / lifetime
   - Liệt kê key đã cấp
   - Kiểm tra 1 key
   - Mở thư mục `keys\issued`

Hoặc PowerShell từ gốc project:

```powershell
cd D:\fb-page-poster

# Khách 1 năm · không giới hạn account/page
node scripts/gen-license.mjs --type commercial --holder "Cong ty ABC" --email "a@x.com" --days 365 --max-accounts 0 --max-pages 0

# Nhân viên 90 ngày · 10 account · 40 page
node scripts/gen-license.mjs --type employee --holder "NV-An" --days 90 --max-accounts 10 --max-pages 40

# Gắn 1 máy (machine_id lấy từ app tab License của khách)
node scripts/gen-license.mjs --type commercial --holder "Shop1" --days 365 --bind-machine "7331b8..."

# Vĩnh viễn
node scripts/gen-license.mjs --type lifetime --holder "VIP" --lifetime

# Xem danh sách
node scripts/list-licenses.mjs

# Kiểm tra key
node scripts/verify-license-key.mjs --file keys\issued\ten-file.txt
```

Key lưu tại: `keys/issued/<type>_<holder>_<timestamp>.txt`

---

## Khách kích hoạt

1. Mở app → tab **License** (hoặc `/license.html`)
2. Dán KEY (dòng dài `payload.chữ_ký`)
3. Bấm kích hoạt

Key được ghi vào `data/license.json` cạnh EXE — **giữ sau update** nếu không xóa `data/`.

---

## Ý nghĩa giới hạn

| max_accounts / max_pages | Ý nghĩa |
|--------------------------|---------|
| `0` | Không giới hạn |
| `> 0` | Tối đa số account / page |

Trial (chưa key): 7 ngày · 2 account · 6 page (mặc định).

---

## Checklist khi ship khách

1. Build: `npm run build:customer` (hoặc copy EXE từ `pack-customer`)
2. **Không** kèm `.env` có secret Meta của bạn (khách tự setup / first-run)
3. **Không** kèm `keys/license-private.pem`
4. Gửi kèm file `.txt` key vừa cấp + hướng dẫn máy mới
