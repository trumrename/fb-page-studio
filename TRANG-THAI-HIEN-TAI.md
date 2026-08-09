# Trạng thái hiện tại — FB Page Studio **v1.2.72**

**Cập nhật:** 2026-07-30  
**Channel ship:** GitHub Releases **latest** = Setup NSIS

---

## 1. Bản đang ship

| | |
|--|--|
| Version | **1.2.72** |
| Tag | `v1.2.72` |
| Setup (online) | https://github.com/trumrename/fb-page-studio/releases/latest/download/FB-Page-Studio-Setup.exe |
| Setup (local build) | `F:\FB-Page-Studio\dist-desktop-oauth\FB-Page-Studio-Setup-v1.2.72.exe` |
| Copy E: | `E:\FB-Page-Studio\dist-desktop-oauth\FB-Page-Studio-Setup-v1.2.72.exe` |
| Source | `C:\Users\NCpc\fb-page-poster\` |
| Runtime data | `%APPDATA%\fb-page-studio\` |

### Stack fix gần nhất (đã gộp trong 1.2.72)

| Ver | Fix |
|-----|-----|
| 1.2.72 | Chrome **Portable**: `ChromePortable.exe` + URL only |
| 1.2.71 | Không ép system Chrome User Data/Profile |
| 1.2.70 | Bulk delete không OOM / app out; hide-to-tray |
| 1.2.69 | Live DELETE `shared_story` + gate `test:delete-live` |
| 1.2.67–68 | Filter «đến hết ngày»; branding checkbox an toàn |

---

## 2. Cài đặt máy khách

1. Thoát tool cũ (tray + Task Manager)  
2. Chạy Setup latest → cài **đè**  
3. Data/env **giữ** tại AppData  
4. Portable: `FB_BROWSER_PATH=...\ChromePortable.exe`  
5. Chạy app  

**Không** cần tạo lại `.env` nếu đã dùng trước (trừ máy mới).

---

## 3. Gate / test (lần ship delete + desktop)

| Gate | Kết quả (khi ship) |
|------|---------------------|
| Unit date filter | PASS |
| LIVE list + DELETE shared_story | PASS (Animals are family, AppData tokens) |
| visitor_posts / tagged / cover hand-upload | Meta #200 (document, không ship-block) |
| Chrome Portable launch policy | Code 1.2.72 |

Lệnh:

```powershell
cd C:\Users\NCpc\fb-page-poster
npm test
$env:FB_USER_DIR="$env:APPDATA\fb-page-studio"
npm run test:delete-live
```

---

## 4. Phân phối

| Gói | Path / URL |
|-----|------------|
| Setup latest | GitHub `/releases/latest/download/FB-Page-Studio-Setup.exe` |
| pack-dev | `Tổng Hợp Tool\pack-dev\` |
| pack-customer | `Tổng Hợp Tool\pack-customer\` |
| Admin key | `Tổng Hợp Tool\Admin-Quan-Ly\` (nếu có) |
| Bản cũ | `Tổng Hợp Tool\Luu-Tru-Ban-Cu\` |

---

## 5. Đang biết / ngoài scope

| Hạng mục | Ghi chú |
|----------|---------|
| Xóa 100% page | Không — #200 same-app / not by app |
| Visitor share về tường | Graph #200 không quyền |
| npm test P2 rotation order | Đã từng flake — ship desktop/delete vẫn qua gate riêng |
| Session cookie tool | Tách `fb-session-ops` / `ENABLE_HTTP_OPS=1` — không mặc định SAFE |
| Ổ C đầy | Build output → `F:\FB-Page-Studio\dist-desktop-oauth\` |

---

## 6. Docs

- `TONG-QUAN.md` — tổng quan  
- `CHECK-BUG.md` — checklist test  
- `DOC-INDEX.md` — mục lục  
- `DOWNLOAD.md` — link tải  
- `HAI-TOOL-TACH-ROI.md` — SAFE vs Session  

---

*Snapshot vận hành — cập nhật mỗi khi ship version mới.*
