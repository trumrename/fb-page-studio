# PACK DEV — Máy của bạn (nguồn gốc)

> **Đây là gói / quy ước cho MÁY LẬP TRÌNH.**  
> Không zip cả folder này gửi khách.

## Đường dẫn gốc

```
D:\fb-page-poster\
```

Đây là **file gốc** duy nhất để code, fix, build, cấp license.

| Thành phần | Đường dẫn | Ghi chú |
|------------|-----------|---------|
| Source code | `D:\fb-page-poster\src\` | Backend |
| UI | `D:\fb-page-poster\public\` | HTML/CSS/JS |
| Electron | `D:\fb-page-poster\electron\` | Desktop shell |
| Private license key | `D:\fb-page-poster\keys\license-private.pem` | **TUYỆT ĐỐI không gửi / không GH** |
| Key đã cấp | `D:\fb-page-poster\keys\issued\` | Nội bộ |
| `.env` Meta App | `D:\fb-page-poster\.env` | App ID/Secret của bạn |
| DB dev | `D:\fb-page-poster\data\` | Token test — không ship |
| Docs | `TONG-QUAN.md` · `TIEN-DO.md` · `CHECK-BUG.md` | |
| Build output | `dist-desktop-oauth\` · `dist-desktop\` | Sau `npm run build:desktop` |

## Chỉ có trên máy DEV (không đưa khách)

- `keys/license-private.pem`
- `keys/issued/*`
- `.env` (secret thật)
- `data/app.db` có token FB
- Toàn bộ source + `node_modules`
- Script `scripts/gen-license.mjs` (có thể giữ source trên GH nhưng private key thì không)

## Việc làm hàng ngày trên DEV

```powershell
cd D:\fb-page-poster
npm start                    # chạy dev
npm test                     # rebuild native + chạy toàn bộ kiểm thử
node scripts/gen-license.mjs --type commercial --holder "KH" --days 365
npm run build:desktop        # build exe
node scripts/sync-customer-pack.mjs   # đổ exe + file an toàn sang pack-customer
```

## Trạng thái bản v1.2.2

- Workspace UI đã tách rõ theo quy trình vận hành.
- Rotation hỗ trợ từng App và hai App so le; job tuần tự, có tiến trình và thông báo.
- Có khóa theo Page, khóa scheduler và lưu trạng thái job sau restart.
- Bài hẹn Facebook được đối soát tự động mỗi 5 phút.
- Báo cáo ngày nằm trong `data\exports\daily`: Page theo App, lịch sử đăng và follower 1/3/7/30 ngày.
- Tác vụ cuối ngày chạy theo giờ Việt Nam lúc 23:59.
- Khi follower trống, kiểm tra token có `pages_show_list`, `pages_read_engagement` và quyền Page tương ứng.

## Quy tắc với AI / khi fix

1. **Sửa code** trong `D:\fb-page-poster` (gốc).  
2. **Build xong** → chạy `sync-customer-pack` để cập nhật `pack-customer\`.  
3. **Không** tự `git push` / tạo Release GH — **hỏi bạn trước**.  
4. Sau khi bạn OK mới push + upload exe lên Release.

## GitHub

- Repo: https://github.com/trumrename/fb-page-studio  
- Code public/private theo repo — **private key không bao giờ commit**  
