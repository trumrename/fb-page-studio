# Đưa FB Page Studio lên GitHub + bản .exe

## 1. Tạo repo GitHub

1. Vào https://github.com/new  
2. Tên gợi ý: `fb-page-studio` (Public hoặc Private)  
3. **Không** tick “Add README” nếu đã có code local  

## 2. Push code (máy bạn)

```powershell
cd C:\Users\NCpc\fb-page-poster

git init
git add .
git commit -m "FB Page Studio v1.0.0 — portable exe + update"
git branch -M main
git remote add origin https://github.com/YOUR_USER/fb-page-studio.git
git push -u origin main
```

> **Không** commit file `.env` (đã có trong `.gitignore`). Secrets chỉ nằm local / cạnh file exe.

## 3. Build 1 file .exe

```powershell
cd C:\Users\NCpc\fb-page-poster
npm install
npm run build:exe
# hoặc kèm zip:
npm run release:zip
```

Kết quả:

```
dist/FB-Page-Studio.exe
dist/.env.example
dist/README-CHAY-APP.txt
```

## 4. Tạo GitHub Release (bản phát hành)

1. Repo → **Releases** → **Draft a new release**  
2. Tag: `v1.0.0` (trùng `package.json` version)  
3. Title: `FB Page Studio v1.0.0`  
4. Upload **`FB-Page-Studio.exe`**  
   - **Tên file asset phải đúng:** `FB-Page-Studio.exe`  
5. Publish release  

## 5. Cấu hình app để nút Cập nhật hoạt động

Trong file `.env` cạnh `FB-Page-Studio.exe`:

```env
GITHUB_REPO=YOUR_USER/fb-page-studio
```

Trong UI: bấm **v1.0.0** (top bar) hoặc menu **Cập nhật phiên bản**.

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
