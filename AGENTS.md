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

## Cổng phát hành — BẮT BUỘC, KHÔNG ĐƯỢC BỎ QUA

- Không upload EXE thủ công lấy từ một build cũ. Mọi release phải build lại từ đúng commit/tag.
- Trước khi tạo tag/release phải chạy đủ: `npm test`, `npm run build:desktop`, `npm run pack:customer`, `npm run release:verify`.
- Chỉ được phát hành khi version ở `package.json`, `package-lock.json`, `pack-customer/VERSION.txt` và `app.asar/package.json` trong EXE build trùng hoàn toàn.
- Hash SHA-256 của `dist-desktop-oauth/FB-Page-Studio-Desktop.exe` và `pack-customer/FB-Page-Studio-Desktop.exe` phải trùng.
- Version/tag mới phải lớn hơn GitHub Release hiện tại. Asset mới không được trùng hash với asset của version trước.
- Tag GitHub phải có đúng dạng `v<package.version>`. Nếu bất kỳ kiểm tra nào lỗi: dừng release, không push tag, không upload asset.
- Release chính thức ưu tiên workflow `.github/workflows/release-desktop.yml`; workflow tự build từ tag và chạy cổng kiểm duyệt trước khi upload.
- Sau mỗi thay đổi updater phải giữ kiểm tra: bỏ cache GitHub, hiển thị tiến trình, đóng Electron trước khi thay EXE, giữ `.env`/`data`/license và báo rõ nếu thay file thất bại.

## License

- Private key chỉ trên máy DEV: `keys/license-private.pem`
- Update app phải **giữ** `data/license.json` (đã code sẵn)
