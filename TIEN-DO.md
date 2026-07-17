# TIẾN ĐỘ / GHI NHỚ ĐÃ LÀM

> Cập nhật: **2026-07-17** · Code: **1.2.0**  
> **Gốc DEV:** `D:\fb-page-poster\`  
> **Gói KHÁCH:** `D:\fb-page-poster\pack-customer\`  
> **GitHub:** `trumrename/fb-page-studio` — **push chỉ khi user OK**

---

## Hai gói (quan trọng)

| | DEV (máy bạn) | KHÁCH |
|--|---------------|--------|
| Path | `D:\fb-page-poster\` + `pack-dev\` | `pack-customer\` |
| Có source? | Có | Không |
| Có private key? | Có (`keys/license-private.pem`) | **Không** |
| Có .exe? | Build ra `dist-desktop-oauth\` | Copy vào pack-customer khi sync |
| Cấp key? | Có | Chỉ **nhận** key / trial |

Sync gói khách:

```powershell
cd D:\fb-page-poster
npm run build:desktop
node scripts/sync-customer-pack.mjs
```

---

## Mốc đã hoàn thành

### A. Nền tảng (v1.0 → v1.1)
- [x] OAuth multi-account, page token mã hóa
- [x] Sync pages / followers / export
- [x] Publish text/photo/video · caption random · media inbox
- [x] Hẹn giờ FB bulk
- [x] Anti-spam preset
- [x] Jobs % + toast + CSV/Excel
- [x] Electron desktop + OAuth 2FA external

### B. Multi Meta App + Rotation (v1.2)
- [x] App1 / App2 env + OAuth `meta_app_key`
- [x] UI Connect + badge
- [x] Rotation so-le · khung giờ · gap · API + UI
- [x] Fix app2 không fallback app1
- [x] `scripts/test-requirements.mjs`

### C. License (v1.2)
- [x] Ed25519 · trial · employee/commercial/lifetime
- [x] UI `/license.html` · gate publish/connect
- [x] **Giữ key sau update** (`data/license.json` + backup)
- [x] `LICENSE-KEYS.md` · `gen-license.mjs`

### D. Auto-update (v1.2.x)
- [x] Banner + nút cập nhật · recheck 4h
- [x] Default GITHUB_REPO · khớp .exe
- [x] Update chỉ thay exe — không xóa data/license
- [ ] Upload .exe lên GH Release (khi bạn build + đồng ý)

### E. Tách gói DEV / KHÁCH (mới)
- [x] `pack-dev/README-DEV.md`
- [x] `pack-customer/` + README-KHACH + .env.example
- [x] `scripts/sync-customer-pack.mjs`
- [x] `AGENTS.md` — **hỏi trước khi push GH**
- [x] Cập nhật TONG-QUAN / TIEN-DO / CHECK-BUG

---

## Chưa làm / chờ bạn

| Hạng mục | Ai |
|----------|-----|
| `FB_APP_ID_2` nếu dùng App 2 | Bạn |
| Build + sync pack-customer có .exe | Bạn / AI khi được lệnh build |
| Push GH / Release có asset | **Chỉ khi bạn OK** |
| Online revoke license | Sau |

---

## Quy trình mỗi lần fix / build (song song 2 gói)

1. Sửa trên **gốc** `D:\fb-page-poster`  
2. Test (`test-requirements` + `CHECK-BUG.md`)  
3. Build desktop (nếu cần ship)  
4. `node scripts/sync-customer-pack.mjs` → cập nhật **pack-customer**  
5. Cập nhật dòng ngày trong TIEN-DO / CHECK-BUG nếu đổi lớn  
6. **Hỏi bạn:** có cập nhật GitHub không? → **Không tự push**

---

## Lệnh nhanh

```powershell
cd D:\fb-page-poster
npm start
node scripts/test-requirements.mjs
node scripts/gen-license.mjs --type lifetime --holder "KH" --lifetime
npm run build:desktop
node scripts/sync-customer-pack.mjs
```
