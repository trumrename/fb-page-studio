# Báo cáo test toàn bộ tool — 2026-07-17

Workspace: `D:\fb-page-poster`  
Server test: Node `src/server.js` port 3847

## Kết quả tổng

| Nhóm | Kết quả |
|------|---------|
| UI / static | PASS |
| Core API (accounts/pages/stats) | PASS |
| OAuth helper (external + 2FA tip) | PASS |
| Posting config | PASS |
| Anti-spam | PASS |
| Captions pool | PASS |
| Job đăng text 1 page | PASS (live FB) |
| Job bulk 3 page text | PASS (sau fix) |
| Schedule dry-run | PASS |
| Reports CSV/Excel | PASS |
| Preferred hours / active times | PASS |
| Export pages CSV | PASS |
| Update check GitHub | PASS |

**Live post OK** trên Facebook (text feed).

---

## Bug đã tìm & sửa trong phiên test

1. **Caption random retry** — retry vẫn random trúng caption trùng → sửa `pickCaption(..., exclude)` + sequential retry  
2. **Backoff Graph sai** — lỗi local (hết caption) bị coi là Graph fail → khóa cả app ~phút → chỉ `noteGraphFailure` khi lỗi Graph thật  
3. **Clamp config** — max/interval khi save áp anti-spam floor  
4. **UI Đăng ngay** — tách rõ khối xanh vs hẹn giờ vàng  
5. **OAuth 2FA** — external browser, bỏ rerequest, scope gọn  

---

## Lưu ý vận hành (không phải bug)

| Hiện tượng | Ý nghĩa |
|------------|---------|
| Caption trùng 48h | Cần kho caption **lớn** khi đăng nhiều page liên tiếp |
| Force ignore quota | Bị khóa khi `allow_ignore_quota=OFF` (đúng) |
| Desktop exe | Cần rebuild sau sửa code; chạy `npm run desktop` hoặc package lại |
| better-sqlite3 | `npm rebuild` cho Node; `@electron/rebuild` cho Desktop |

---

## Cách chạy sau test

```powershell
cd D:\fb-page-poster
npm start
# hoặc
npm run desktop
```

App console: http://127.0.0.1:3847/app.html  
Desktop: `FB-Page-Studio-App` / `dist-desktop-oauth` (nếu đã build)
