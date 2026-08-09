/**
 * Mã lỗi login / checkpoint — hiển thị UI & log thống nhất.
 * code = máy đọc được · message_vi = user · action = gợi ý xử lý
 */

/** @type {Record<string, { code: string, message_vi: string, action: string, retryable: boolean, severity: 'info'|'warn'|'error' }>} */
export const LOGIN_ERRORS = {
  OK: {
    code: "OK",
    message_vi: "Đăng nhập / cookie OK",
    action: "Tiếp tục job session",
    retryable: false,
    severity: "info",
  },
  COOKIE_ALIVE: {
    code: "COOKIE_ALIVE",
    message_vi: "Cookie còn sống — bỏ qua login",
    action: "Dùng session hiện có",
    retryable: false,
    severity: "info",
  },
  BAD_FORMAT: {
    code: "BAD_FORMAT",
    message_vi: "Sai định dạng tài khoản (cần id|pass|2fa)",
    action: "Sửa dòng: email_hoặc_sdt|mat_khau|SECRET_2FA",
    retryable: false,
    severity: "error",
  },
  MISSING_CREDENTIALS: {
    code: "MISSING_CREDENTIALS",
    message_vi: "Thiếu id hoặc mật khẩu",
    action: "Bổ sung id|pass",
    retryable: false,
    severity: "error",
  },
  INVALID_2FA_SECRET: {
    code: "INVALID_2FA_SECRET",
    message_vi: "Secret 2FA không hợp lệ (cần key Base32 authenticator)",
    action: "Dán secret từ app Authenticator, không dán mã 6 số",
    retryable: false,
    severity: "error",
  },
  WRONG_PASSWORD: {
    code: "WRONG_PASSWORD",
    message_vi: "Sai mật khẩu hoặc tài khoản",
    action: "Đổi pass trên FB rồi cập nhật lại trong tool",
    retryable: false,
    severity: "error",
  },
  NEED_2FA: {
    code: "NEED_2FA",
    message_vi: "Facebook yêu cầu mã 2FA authenticator",
    action: "Đảm bảo có secret 2FA đúng; tool sẽ tự sinh mã",
    retryable: true,
    severity: "warn",
  },
  BAD_2FA_CODE: {
    code: "BAD_2FA_CODE",
    message_vi: "Mã 2FA sai hoặc hết hạn",
    action: "Đồng bộ giờ máy; kiểm tra secret; thử lại 1 lần",
    retryable: true,
    severity: "warn",
  },
  CHECKPOINT_282: {
    code: "CHECKPOINT_282",
    message_vi: "Checkpoint 282 — Facebook gửi mã xác minh (thường về email)",
    action: "Chờ tool đọc mail hoặc dán mã 6–8 số từ email FB",
    retryable: true,
    severity: "warn",
  },
  CHECKPOINT_282_CODE_SENT: {
    code: "CHECKPOINT_282_CODE_SENT",
    message_vi: "Đã yêu cầu mã 282 — đang chờ mã từ email / người dùng",
    action: "Kiểm tra hộp thư (và spam); hoặc POST mã vào API submit-code",
    retryable: true,
    severity: "warn",
  },
  CHECKPOINT_282_WAIT_CODE: {
    code: "CHECKPOINT_282_WAIT_CODE",
    message_vi: "Đang chờ mã email checkpoint 282",
    action: "Dán mã trong vòng 10–15 phút",
    retryable: true,
    severity: "warn",
  },
  CHECKPOINT_282_BAD_CODE: {
    code: "CHECKPOINT_282_BAD_CODE",
    message_vi: "Mã email 282 sai hoặc hết hạn",
    action: "Xin mã mới trên FB / kiểm tra mail mới nhất",
    retryable: true,
    severity: "error",
  },
  CHECKPOINT_282_TIMEOUT: {
    code: "CHECKPOINT_282_TIMEOUT",
    message_vi: "Hết thời gian chờ mã email 282",
    action: "Chạy lại login; chuẩn bị IMAP hoặc dán mã nhanh hơn",
    retryable: true,
    severity: "error",
  },
  CHECKPOINT_OTHER: {
    code: "CHECKPOINT_OTHER",
    message_vi: "Checkpoint khác (ảnh, video selfie, bạn bè…)",
    action: "Mở browser profile / login tay 1 lần, xong lấy cookie",
    retryable: false,
    severity: "error",
  },
  CAPTCHA: {
    code: "CAPTCHA",
    message_vi: "Gặp captcha / robot check",
    action: "Giảm tần suất login; dùng proxy sạch; login tay 1 lần",
    retryable: true,
    severity: "error",
  },
  DISABLED_ACCOUNT: {
    code: "DISABLED_ACCOUNT",
    message_vi: "Tài khoản bị khóa / disable",
    action: "Khôi phục trên facebook.com; không spam login",
    retryable: false,
    severity: "error",
  },
  EMAIL_IMAP_FAIL: {
    code: "EMAIL_IMAP_FAIL",
    message_vi: "Không đọc được mail (IMAP lỗi / sai app password)",
    action: "Kiểm tra IMAP + app password Gmail; hoặc dán mã tay",
    retryable: true,
    severity: "warn",
  },
  EMAIL_CODE_NOT_FOUND: {
    code: "EMAIL_CODE_NOT_FOUND",
    message_vi: "Không thấy mã Facebook trong mail (hết thời gian poll)",
    action: "Dán mã tay; kiểm tra đúng hộp thư / thư mục spam",
    retryable: true,
    severity: "warn",
  },
  BROWSER_NOT_AVAILABLE: {
    code: "BROWSER_NOT_AVAILABLE",
    message_vi: "Chưa cài Playwright / không mở được browser login",
    action: "npm i playwright && npx playwright install chromium",
    retryable: false,
    severity: "error",
  },
  BROWSER_TIMEOUT: {
    code: "BROWSER_TIMEOUT",
    message_vi: "Login browser quá thời gian",
    action: "Thử lại; kiểm tra mạng / proxy",
    retryable: true,
    severity: "error",
  },
  NETWORK: {
    code: "NETWORK",
    message_vi: "Lỗi mạng khi login Facebook",
    action: "Kiểm tra mạng, proxy, DNS",
    retryable: true,
    severity: "error",
  },
  PROXY_ERROR: {
    code: "PROXY_ERROR",
    message_vi: "Proxy lỗi hoặc bị chặn",
    action: "Đổi proxy / bỏ proxy thử lại",
    retryable: true,
    severity: "error",
  },
  UNKNOWN: {
    code: "UNKNOWN",
    message_vi: "Lỗi login không xác định",
    action: "Xem log chi tiết / screenshot; login tay lấy cookie",
    retryable: true,
    severity: "error",
  },
};

/**
 * @param {string} code
 * @param {string} [detail]
 */
export function loginError(code, detail = "") {
  const base = LOGIN_ERRORS[code] || LOGIN_ERRORS.UNKNOWN;
  return {
    ok: code === "OK" || code === "COOKIE_ALIVE",
    code: base.code,
    message_vi: base.message_vi,
    action: base.action,
    retryable: base.retryable,
    severity: base.severity,
    detail: detail ? String(detail).slice(0, 1500) : null,
    at: new Date().toISOString(),
  };
}

/** Heuristic classify page URL / HTML after navigation */
export function classifyLoginPage(url = "", html = "") {
  const u = String(url).toLowerCase();
  const h = String(html).slice(0, 50000).toLowerCase();
  const blob = `${u}\n${h}`;

  if (/checkpoint\/\d*282|282|code.?generator|approvals_code|submitcode/i.test(blob)) {
    if (/email|mail|hộp thư|inbox/i.test(blob)) {
      return "CHECKPOINT_282";
    }
    return "CHECKPOINT_282";
  }
  if (/checkpoint|two.?step|identity.?confirm|secure\.facebook/i.test(blob)) {
    if (/upload|video|photo|selfie|friend/i.test(blob)) return "CHECKPOINT_OTHER";
    return "CHECKPOINT_OTHER";
  }
  if (/captcha|recaptcha|nocaptcha|security.?check/i.test(blob)) return "CAPTCHA";
  if (/disabled|bị vô hiệu|account.*lock/i.test(blob)) return "DISABLED_ACCOUNT";
  if (/incorrect.*(pass|password)|sai mật khẩu|wrongpassword/i.test(blob)) {
    return "WRONG_PASSWORD";
  }
  if (/two.?factor|authentication.?code|nhập mã|approvals_code|otp/i.test(blob)) {
    return "NEED_2FA";
  }
  if (/facebook\.com\/?$|facebook\.com\/home|\/feed|login_success/i.test(u) && !/login/i.test(u)) {
    return "OK";
  }
  return "UNKNOWN";
}
