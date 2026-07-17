# Quy tắc làm việc (DEV)

## Hai gói tách biệt

| Gói | Path | Mục đích |
|-----|------|----------|
| **Gốc DEV** | `D:\fb-page-poster\` + `pack-dev\` | Code, fix, build, cấp key |
| **Gói KHÁCH** | `D:\fb-page-poster\pack-customer\` | Chỉ file giao khách |

Khi **fix tool** hoặc **build**: cập nhật logic trên gốc DEV, rồi **đồng bộ pack-customer** (`node scripts/sync-customer-pack.mjs`).

## GitHub — BẮT BUỘC hỏi user

- **Không** `git push`, tạo tag, tạo/sửa GitHub Release, upload exe lên GH  
  **trừ khi user đồng ý rõ** trong hội thoại.
- Khi xong việc: báo cáo thay đổi + hỏi:  
  *“Bạn có muốn cập nhật lên GitHub (push / release) không?”*

## License

- Private key chỉ trên máy DEV: `keys/license-private.pem`
- Update app phải **giữ** `data/license.json` (đã code sẵn)
