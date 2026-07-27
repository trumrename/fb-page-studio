# FB Page Studio v1.2.49

**Sửa OAuth** (lỗi: *Error validating verification code / redirect_uri identical*)

## Nguyên nhân
- Dialog Facebook dùng `https://modelswiki.top/auth/facebook/callback`
- Đổi code đôi khi dùng `http://127.0.0.1:3847/...` (config cũ / localhost)
- Meta yêu cầu **hai bước giống hệt** → fail

## Fix
1. `resolveOauthRedirectUri()` — OAUTH_RELAY=1 luôn ép HTTPS public (modelswiki), không dùng localhost
2. Lưu `redirect_uri` vào session OAuth lúc mở dialog; exchange **bắt buộc** dùng URI đó
3. Thông báo lỗi rõ khi mismatch

## File cài
- `FB-Page-Studio-Setup-v1.2.49.exe` (thay cho 1.2.48)
- Portable: `FB-Page-Studio-Desktop-v1.2.49.exe`

## .env dev (bắt buộc)
```
OAUTH_RELAY=1
OAUTH_RELAY_URL=https://modelswiki.top
FB_REDIRECT_URI=https://modelswiki.top/auth/facebook/callback
```
Meta App → Valid OAuth Redirect URIs = **đúng 1 dòng trên**.
