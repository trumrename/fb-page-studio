# Quy tắc làm việc (DEV)

## Hai gói tách biệt

| Gói | Path | Mục đích |
|-----|------|----------|
| **Gốc DEV** | `D:\fb-page-poster\` | Code, fix, build |
| **Tổng Hợp Tool** | `D:\fb-page-poster\Tổng Hợp Tool\` | Admin + khách + nội bộ + dev + release ZIP |
| **Gói KHÁCH** | `Tổng Hợp Tool\pack-customer\` | Chỉ file giao khách |
| **Gói NỘI BỘ** | `Tổng Hợp Tool\pack-internal\` | EXE + secret (tin cậy) |
| **Gói DEV** | `Tổng Hợp Tool\pack-dev\` | Test admin |

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
- Asset tải thủ công bắt buộc có version trong tên: `FB-Page-Studio-Desktop-vX.Y.Z.exe`, kèm file SHA-256. Không upload asset tên chung chung.
- Version/tag mới phải lớn hơn GitHub Release hiện tại. Asset mới không được trùng hash với asset của version trước.
- Tag GitHub phải có đúng dạng `v<package.version>`. Nếu bất kỳ kiểm tra nào lỗi: dừng release, không push tag, không upload asset.
- Release chính thức ưu tiên workflow `.github/workflows/release-desktop.yml`; workflow tự build từ tag và chạy cổng kiểm duyệt trước khi upload.
- Sau mỗi thay đổi updater phải giữ kiểm tra: bỏ cache GitHub, hiển thị tiến trình, đóng Electron trước khi thay EXE, giữ `.env`/`data`/license và báo rõ nếu thay file thất bại.
- Sau khi phát hành phải chạy workflow `Smoke test released EXE` trên Windows VM: tải chính asset GitHub, mở EXE trong thư mục sạch và xác nhận runtime version + API + trạng thái Ngrok thiếu token.

## License

- Private key chỉ trên máy DEV: `keys/license-private.pem`
- Update app phải **giữ** `data/license.json` (đã code sẵn)

## Checklist yêu cầu lâu dài

- Trước khi sửa/build phải đọc YEU-CAU-BAT-BUOC.md, đối chiếu với TIEN-DO.md và báo cáo kiểm thử hiện có.
- Mọi lỗi đã từng gặp phải được thêm thành kiểm tra hồi quy trong scripts/test-requirements.mjs; không coi là đã xử lý nếu chỉ sửa giao diện mà chưa có test.
- Bộ chọn thư mục bắt buộc là Explorer đầy đủ ổ đĩa: Electron dùng dialog.showOpenDialog với openDirectory; server fallback dùng OpenFileDialog. Cấm quay lại FolderBrowserDialog.
