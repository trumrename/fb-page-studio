# Chỉ mục tài liệu FB Page Studio

**Version:** v1.2.72 · **Cập nhật:** 2026-07-30

Dùng file này để tìm đúng doc — tránh đọc bản cũ trong root.

---

## Bắt buộc đọc (ship / dev)

| File | Mục đích |
|------|----------|
| **[TONG-QUAN.md](./TONG-QUAN.md)** | Tổng quan tool, kiến trúc, tính năng, giới hạn Meta |
| **[CHECK-BUG.md](./CHECK-BUG.md)** | Checklist test trước ship (OAuth, Portable, xóa, đăng) |
| **[TRANG-THAI-HIEN-TAI.md](./TRANG-THAI-HIEN-TAI.md)** | Snapshot version, path Setup, gate hiện tại |
| **[YEU-CAU-BAT-BUOC.md](./YEU-CAU-BAT-BUOC.md)** | Rule bắt buộc (AGENTS / release) |
| **[AGENTS.md](./AGENTS.md)** | Quy tắc agent/dev trong repo |
| **[DOWNLOAD.md](./DOWNLOAD.md)** | Link tải Setup/Portable cố định |
| **[README.md](./README.md)** | Entry GitHub ngắn |

---

## Cài đặt & OAuth

| File | Mục đích |
|------|----------|
| [SETUP.md](./SETUP.md) | Setup Meta App / env |
| [HUONG-DAN.md](./HUONG-DAN.md) | Hướng dẫn chung |
| [HUONG-DAN-MAY-MOI.md](./HUONG-DAN-MAY-MOI.md) | Máy khách mới |
| [HUONG-DAN-OAUTH-RELAY.md](./HUONG-DAN-OAUTH-RELAY.md) | Relay modelswiki.top |
| [HUONG-DAN-DOMAIN-OAUTH-RELAY.md](./HUONG-DAN-DOMAIN-OAUTH-RELAY.md) | Domain relay chi tiết |
| [HUONG-DAN-DOMAIN-MAY-TREO-NHA.md](./HUONG-DAN-DOMAIN-MAY-TREO-NHA.md) | Máy treo nhà + domain |
| [FIX-DESKTOP.md](./FIX-DESKTOP.md) | Lỗi desktop thường gặp |

---

## Phân phối & license

| File | Mục đích |
|------|----------|
| [GITHUB.md](./GITHUB.md) | Tag / release GitHub |
| [LICENSE-KEYS.md](./LICENSE-KEYS.md) | Sinh / verify key |
| [HAI-GOI-NOI-BO-VA-KHACH.md](./HAI-GOI-NOI-BO-VA-KHACH.md) | pack internal vs customer |
| [HAI-TOOL-TACH-ROI.md](./HAI-TOOL-TACH-ROI.md) | SAFE Graph vs Session Ops |

---

## Server / deploy

| File | Mục đích |
|------|----------|
| [HUONG-DAN-SERVER-TRUNG-TAM.md](./HUONG-DAN-SERVER-TRUNG-TAM.md) | `DEPLOY_MODE=central` |
| [BAO-CAO-KIEM-TRA-PACK-SERVER-NOI-BO.md](./BAO-CAO-KIEM-TRA-PACK-SERVER-NOI-BO.md) | Check pack server |

---

## Lịch sử / báo cáo test (có thể cũ hơn version)

| File | Mục đích |
|------|----------|
| [TIEN-DO.md](./TIEN-DO.md) | Nhật ký tiến độ (các mốc cũ) |
| [BAO-CAO-TEST.md](./BAO-CAO-TEST.md) | Báo cáo test lịch sử |
| [BAO-CAO-XAC-THUC-GROK.md](./BAO-CAO-XAC-THUC-GROK.md) | Xác thực Grok / release |

> Ưu tiên **TRANG-THAI-HIEN-TAI.md** + **CHECK-BUG.md** cho version đang ship.

---

## Module tùy chọn / tool tách

| File | Mục đích |
|------|----------|
| [HTTP-FULL-OPS.md](./HTTP-FULL-OPS.md) | HTTP ops / session (nếu bật) |
| [LOGIN-AUTO.md](./LOGIN-AUTO.md) | Login auto (tool Session — không mặc định SAFE) |

---

## Path build & data (Windows)

| Vai trò | Path |
|---------|------|
| Source | `C:\Users\NCpc\fb-page-poster\` |
| Setup build output | `F:\FB-Page-Studio\dist-desktop-oauth\` |
| Copy E: | `E:\FB-Page-Studio\dist-desktop-oauth\` |
| pack-dev | `...\Tổng Hợp Tool\pack-dev\` |
| Runtime Setup | `%APPDATA%\fb-page-studio\` |

---

## Quy trình ship gọn

```text
1. Sửa code trên source DEV
2. npm test
3. (nếu đụng xóa) npm run test:delete-live
4. npm run build:desktop:setup
5. CHECK-BUG.md — tick tay smoke
6. Commit + tag vX.Y.Z + gh release (Setup + sha256 + alias Setup.exe)
7. Cập nhật TRANG-THAI-HIEN-TAI.md + TONG-QUAN version
```

---

*Giữ DOC-INDEX đồng bộ khi thêm file .md quan trọng ở root.*
