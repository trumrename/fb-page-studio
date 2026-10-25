/**
 * Lời Facebook giữ nguyên. Tiếng Việt chỉ là bản dịch của đúng câu đó.
 * Không có trong bảng thì không đoán nghĩa.
 */

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function fbErrorParts(err) {
  const fb = err?.fb && typeof err.fb === "object" ? err.fb : {};
  const title = clean(fb.error_user_title);
  const user = clean(fb.error_user_msg);
  const dev = clean(fb.message);
  const code = fb.code ?? err?.code ?? "";
  const sub = fb.error_subcode ?? "";
  const original = [title, user].filter(Boolean).join(" — ") || dev;
  return { title, user, dev, code, sub, original };
}

/** Dịch sát câu tiếng Anh mà Facebook trả. Không khớp thì trả chuỗi rỗng. */
export function translateFbText(text) {
  const raw = clean(text);
  if (!raw) return "";
  const rules = [
    [
      /limit how often you can post[\s\S]*protect the community from spam/i,
      "Facebook giới hạn số lần đăng để bảo vệ cộng đồng khỏi spam.",
    ],
    [
      /protect the community from spam/i,
      "Facebook chặn để bảo vệ cộng đồng khỏi spam.",
    ],
    [
      /please retry your request later|please try again later|unexpected error/i,
      "Facebook bảo thử lại yêu cầu này sau.",
    ],
    [
      /an unknown error (has )?occurred/i,
      "Facebook trả về lỗi không rõ.",
    ],
    [
      /user request limit reached/i,
      "Facebook báo tài khoản này đã hết lượt gọi API.",
    ],
    [
      /application request limit reached/i,
      "Facebook báo ứng dụng đã hết lượt gọi API.",
    ],
    [
      /page request limit reached/i,
      "Facebook báo page này đã hết lượt gọi API.",
    ],
    [
      /there have been too many calls/i,
      "Facebook báo gọi API quá nhiều.",
    ],
    [
      /error validating access token|session has expired|invalid oauth/i,
      "Facebook báo token không còn dùng được.",
    ],
    [
      /checkpoint/i,
      "Facebook báo tài khoản đang bị chặn xác minh.",
    ],
    [
      /requires .*pages_manage_posts|pages_manage_posts/i,
      "Facebook báo thiếu quyền pages_manage_posts.",
    ],
    [
      /deemed abusive or is otherwise disallowed/i,
      "Facebook coi thao tác này là lạm dụng hoặc không cho phép.",
    ],
    [
      /does not have permission|permissions? error|missing permission/i,
      "Facebook báo không đủ quyền cho thao tác này.",
    ],
    [
      /unsupported post request|unsupported get request/i,
      "Facebook báo request này không được hỗ trợ.",
    ],
    [
      /scheduled_publish_time/i,
      "Facebook không nhận giờ hẹn đã gửi.",
    ],
    [
      /reduce the amount of data/i,
      "Facebook bảo giảm lượng dữ liệu rồi gửi lại.",
    ],
    [
      /attachment/i,
      "Facebook từ chối phần đính kèm của request.",
    ],
  ];
  for (const [re, vi] of rules) {
    if (re.test(raw)) return vi;
  }
  return "";
}

export function formatFbNotice(err) {
  if (typeof err === "string") {
    if (/Kiểm tra cấu hình|Facebook nguyên văn/.test(err)) return err;
  }
  const p = fbErrorParts(err);
  const source = p.original || p.dev;
  if (!source) return "";
  const vi = translateFbText([p.user, p.title, p.dev, source].filter(Boolean).join(" "));
  const lines = [];
  if (vi) lines.push(vi);
  lines.push(`Facebook nguyên văn: «${source}»`);
  if (p.dev && p.dev !== source && p.dev !== p.user) {
    lines.push(`Chi tiết kỹ thuật FB: «${p.dev}»`);
  }
  const bits = [p.code, p.sub].filter((v) => v !== "" && v != null);
  if (bits.length) lines.push(`Mã FB: ${bits.join("/")}`);
  return lines.join("\n");
}

export function graphError(fb, fallback = "Graph API error") {
  const error = fb && typeof fb === "object" ? fb : { message: String(fb || fallback) };
  const err = new Error(formatFbNotice({ fb: error }) || error.message || fallback);
  err.code = error.code;
  err.type = error.type;
  err.fb = error;
  return err;
}
