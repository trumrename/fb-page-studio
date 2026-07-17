# Đưa FB Page Studio lên GitHub + bản .exe

**Repo hiện tại:** https://github.com/trumrename/fb-page-studio  
**Version:** xem `package.json` (1.2.0+)

## 1. Push code

```powershell
cd D:\fb-page-poster
git add -A
git status
git commit -m "v1.2.0 multi-app rotation license docs"
git push origin main
```

> **Không** commit: `.env`, `data/`, `keys/license-private.pem`, `keys/issued/`, token, dist nặng.

## 2. Test trước release

```powershell
node scripts/test-requirements.mjs
# + CHECK-BUG.md
```

## 3. Build desktop

```powershell
npm install
npm run build:desktop
# → dist-desktop/FB-Page-Studio-Desktop.exe (tên theo electron-builder.yml)
```

Hoặc portable server cũ:

```powershell
npm run build:exe
```

## 4. GitHub Release

1. Releases → **Draft a new release**  
2. Tag: `v1.2.0` (= version package.json)  
3. Title: `FB Page Studio v1.2.0`  
4. Upload exe — tên asset khớp `updateAsset` trong package.json  
5. Changelog ngắn: multi-app, rotation, license  

## 5. Cập nhật trong app

`.env` cạnh exe:

```env
GITHUB_REPO=trumrename/fb-page-studio
```

UI: **Cập nhật phiên bản**.

## 6. License khi ship

- User trial 7 ngày (hoặc cấp key)  
- Bạn giữ `keys/license-private.pem` offline  
- Hướng dẫn: `LICENSE-KEYS.md`  


App sẽ:

1. Gọi GitHub API `releases/latest`  
2. So sánh version  
3. Tải `.exe` mới → thay file → tự mở lại  

## 6. Phát hành bản mới sau này

```powershell
# Sửa code xong
# Bump version trong package.json → 1.0.1
npm run build:exe
git add . && git commit -m "v1.0.1" && git push
# GitHub Release tag v1.0.1 + upload FB-Page-Studio.exe mới
```

User chỉ cần bấm **Cập nhật** trong app.

## 7. Chạy portable

```
folder/
  FB-Page-Studio.exe
  .env                 ← copy từ .env.example, điền FB + GITHUB_REPO
  data/                ← tự tạo (db, media, exports)
```

Double-click exe → mở http://localhost:3847  

## Lưu ý bảo mật

- Không đưa `FB_APP_SECRET` lên GitHub  
- `TOKEN_ENCRYPTION_KEY` nên random riêng mỗi máy  
- Release Public: ai cũng tải được exe (không kèm secret)  
