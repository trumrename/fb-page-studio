# FB Page Studio v1.2.47

**Ngày:** 2026-07-27  
**Gói:** `Tổng Hợp Tool/pack-customer` · `pack-dev`

## Tính năng mới

### 1. Xóa bài Fanpage siêu nhanh
- UI: `/delete-posts.html` · menu **Xóa bài Page**
- Graph API: list `published_posts` + batch DELETE (50/request)
- Nhiều page song song (1–10), filter ngày/keyword
- Rate-limit: tạm dừng + đếm ngược + tự resume
- Retry lỗi tạm + final sweep
- Báo cáo cuối: **từng page OK/fail** · list link lỗi · CSV/TXT

### 2. Xóa bài Group (Admin / Mod)
- UI: `/delete-group-posts.html` · menu **Xóa bài Group**
- User token nick Admin/Kiểm duyệt
- Dán Group ID thủ công (khuyên dùng) hoặc list Graph (nếu app còn quyền)
- Batch delete + rate-limit + báo cáo lỗi/link theo group

### API
| Path | Mô tả |
|------|--------|
| `/api/delete-posts/*` | Xóa Page |
| `/api/delete-group-posts/*` | Xóa Group |

## Lưu ý
- Không đảm bảo xóa 100% (Meta limit / loại bài / Groups API deprecated)
- Group: dán Group ID nếu list Graph trống
- Build: `npm run build:desktop` rồi `npm run pack:all`

## Gói Tổng Hợp Tool
```
Tổng Hợp Tool\
  pack-customer\   ← KHÁCH v1.2.47
  pack-dev\        ← DEV/admin
  Admin-Quan-Ly\   ← cấp key
```
