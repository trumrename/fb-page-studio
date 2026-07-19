# Quy trình GitHub và phát hành FB Page Studio

Repo: [trumrename/fb-page-studio](https://github.com/trumrename/fb-page-studio)

Version chuẩn: `package.json` → **1.2.20**

## Quy tắc

- Không commit `.env`, `data`, token, App Secret, `keys/license-private.pem`, `keys/issued`, `Luu-Tru-Ban-Cu`, EXE/ZIP binary lớn (gitignore).
- Asset khách: `FB-Page-Studio-Desktop-vX.Y.Z.exe` (+ optional `FB-Page-Studio-vX.Y.Z-Windows.zip`).
- Updater ưu tiên asset **đúng version**, không dùng EXE generic làm nguồn chính trên Release.

## Build & đóng gói

```powershell
cd D:\fb-page-poster
npm test
npm run build:desktop
npm run pack:all
npm run release:asset
npm run release:verify
```

`release:verify` phải PASS trước khi upload.

## Commit + push

```powershell
$version = (Get-Content package.json | ConvertFrom-Json).version
git add -A
git status
git commit -m "v$version: customer zip, admin pack, retry fails, active-times fallback"
git push origin main
```

## Tag + Release

```powershell
$version = (Get-Content package.json | ConvertFrom-Json).version
git tag "v$version"
git push origin "v$version"

gh release create "v$version" `
  --title "FB Page Studio v$version" `
  --notes-file - `
  "release-assets/FB-Page-Studio-Desktop-v$version.exe" `
  "release-assets/FB-Page-Studio-Desktop-v$version.exe.sha256.txt" `
  "release-assets/FB-Page-Studio-v$version-Windows.zip" `
  "release-assets/FB-Page-Studio-v$version-Windows.zip.sha256.txt"
```

Hoặc notes ngắn:

```powershell
gh release create "v1.2.20" --title "FB Page Studio v1.2.20" --notes "Portable EXE + Windows ZIP. License, Direct Local, retry failed jobs, preferred hours, ngrok domain qgroup.ngrok.app." --latest release-assets/*
```

## Sau phát hành

- Mở Release → đúng asset versioned  
- Máy test: `/api/update/check` thấy `1.2.20`  
- Cập nhật in-app: giữ data + license  
