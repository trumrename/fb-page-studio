# Trạng thái hệ thống (kiểm tra)

**Thời điểm:** 2026-07-19  
**Version:** 1.2.20

## Kết quả check

| Hạng mục | Trạng thái |
|----------|------------|
| `npm test` | **189/189 PASS** |
| `release:verify` | **PASS** v1.2.20 |
| ZIP khách | `pack-customer\FB-Page-Studio-v1.2.20-Windows.zip` (~76 MB) |
| App live health | OK · v1.2.20 · Graph configured |
| License runtime | **commercial · Owner-Dev** · unlimited |
| EXE App vs build | Hash khớp (portable mới nhất) |
| Ngrok | Token đã cấu hình; domain có thể `domain_busy` nếu máy khác đang giữ `qgroup.ngrok.app` |
| Retry failed jobs | API + UI OK |
| Active times | Preferred / preset VN (Meta deprecate page_fans_online) |

## Cấu trúc gọn sau dọn

| Thư mục | Vai trò |
|---------|---------|
| `FB-Page-Studio-App\` | **Chạy thật** — chỉ EXE 1.2.20 + data + .env |
| `dist-desktop-oauth\` | Build mới (Desktop.exe + v1.2.20) + win-unpacked |
| `pack-customer\` | Gói gửi khách |
| `pack-dev\` | Gói dev |
| `Luu-Tru-Ban-Cu\` | **Lưu trữ** EXE/zip/build/log cũ (~2.2 GB) |
| `Admin-Quan-Ly\` | Menu cấp key / sổ khách |
| `keys\` | Private + issued (bí mật) |
| `src\` `public\` `electron\` | Source |

## Lỗi còn phụ thuộc bên ngoài (không phải bug code)

1. Domain Ngrok 334 nếu endpoint online máy khác → dashboard.ngrok.com stop  
2. Meta OAuth (icon/category/redirect) trên Meta dashboard  
3. Anti-spam caption trùng khi retry — đúng thiết kế  

## Không phát hiện

- Crash server / fail test  
- License trial nhầm (đã commercial)  
- Mất data khi dọn (chỉ move bản cũ)
