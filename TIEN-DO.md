# TIẾN ĐỘ / GHI NHỚ ĐÃ LÀM

> Cập nhật: **2026-07-17** · Phiên bản code: **1.2.0**  
> Repo: `D:\fb-page-poster` · GitHub: `trumrename/fb-page-studio`

---

## Mốc đã hoàn thành

### A. Nền tảng (v1.0 → v1.1)
- [x] OAuth Graph multi-account, page token mã hóa SQLite
- [x] Sync pages, followers, insights +7d, export Excel/CSV
- [x] Publish text/photo/video · caption random txt/csv · media inbox→posted
- [x] Hẹn giờ FB bulk (active times / fixed)
- [x] Anti-spam preset Recommended/Strict/Loose
- [x] Job runner tuần tự + progress % + toast
- [x] Báo cáo `dang_bai_chi_tiet.csv` / `.xlsx`
- [x] Electron desktop + GitHub release/update
- [x] OAuth 2FA qua browser ngoài, ngrok HTTPS

### B. Multi Meta App + Rotation (v1.2)
- [x] `metaApps.js` — App1 từ env, App2 từ `FB_APP_ID_2`
- [x] DB `meta_app_key` / `meta_app_id` · UNIQUE `(fb_user_id, meta_app_key)`
- [x] OAuth `?app=app1|app2` · state nhớ app · token đúng App ID/Secret
- [x] UI Connect **+ App 1** / **+ App 2** · badge app trên account
- [x] Rotation planner so-le App1↔App2 · pageIndex · gap khung giờ · jitter
- [x] API `/api/jobs/rotation/settings|matrix|plan|run`
- [x] UI panel Rotation trên `posting.html`
- [x] Fix: app2 chưa config **không** fallback sang app1
- [x] Suite test: `scripts/test-requirements.mjs` (81 checks / 3 pass)

### C. License key (v1.2)
- [x] Ed25519 sign/verify · public key trong app
- [x] Trial 7 ngày · giới hạn account/page
- [x] UI `/license.html` · API `/api/license/*`
- [x] Gate: Connect account mới · đăng/hẹn giờ khi hết license
- [x] Vendor: `scripts/gen-license.mjs` · `LICENSE-KEYS.md`
- [x] Private key **gitignored** (`keys/license-private.pem`)

### D. Auto-update thông báo (v1.2.x)
- [x] Check GitHub Releases khi mở app + mỗi 4 giờ
- [x] Banner **Có phiên bản mới** + nút **Cập nhật ngay**
- [x] Nút topbar đổi `vX↑` (warn pulse)
- [x] Default `GITHUB_REPO=trumrename/fb-page-studio`
- [x] Khớp asset Desktop.exe / legacy .exe
- [ ] Upload .exe vào mỗi GitHub Release (bạn build khi ship)

---

## Chưa làm / phụ thuộc bạn

| Hạng mục | Ghi chú |
|----------|---------|
| Điền `FB_APP_ID_2` trên Meta | Cần để Connect App 2 thật |
| Connect nick page vào App 2 | Account hiện tại đều `app1` |
| App Review Live | Nếu user ngoài Tester |
| Online license revoke server | Dự phòng sau (hiện offline signed key) |
| Build + upload exe release v1.2.0 | `npm run build:desktop` + GH Release |
| Story Graph API | Chưa hỗ trợ |
| Multi-instance 2 process so le | Chưa (1 process multi-app đủ) |

---

## File quan trọng

| File | Vai trò |
|------|---------|
| `src/services/metaApps.js` | Multi Meta App |
| `src/services/rotationPlan.js` | So-le + giờ |
| `src/services/license.js` | License runtime |
| `scripts/gen-license.mjs` | Cấp key |
| `scripts/test-requirements.mjs` | Check yêu cầu 3 pass |
| `TONG-QUAN.md` | Tổng quan |
| `CHECK-BUG.md` | Checklist bug |
| `LICENSE-KEYS.md` | Hướng dẫn key |

---

## Lệnh hay dùng

```powershell
cd D:\fb-page-poster
npm start
node scripts/test-requirements.mjs
node scripts/gen-license.mjs --type employee --holder "NV01" --days 90 --max-accounts 15 --max-pages 50
git push origin main
```

---

## Quyết định sản phẩm đã chốt với user

1. Đăng **tuần tự**, không song song mạnh  
2. 1 nick page ≈ 2–3 page; bulk ~8–12 page/lần  
3. 1 Dev Meta cầm nhiều app OK; nick page tách pool theo app  
4. Rotation: so le app · gap chỉ cùng page  
5. License cho bán / nhân viên; chống crack = **lớp rào**, không hứa 100%  
