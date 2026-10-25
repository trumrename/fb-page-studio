/**
 * Một lần chạy chỉ giữ field của timing_source đó.
 * start_at không bị list giờ đè. List giờ không lấy số bài của mode khác.
 * Không có timing_source thì giữ thứ tự cũ: times[] thắng start_at.
 */
export function lockScheduleTiming(body = {}) {
  const timing = String(body.timing_source || "");
  const times = Array.isArray(body.times) ? body.times : [];
  let useTimes = times;
  let useStart = body.start_at || "";
  let postsPerDay = body.posts_per_day != null ? Number(body.posts_per_day) : null;
  if (!Number.isFinite(postsPerDay)) postsPerDay = null;

  if (timing === "start_at_interval") {
    useTimes = [];
    postsPerDay = null;
  } else if (timing === "list_times") {
    useStart = "";
    postsPerDay = null;
  } else if (timing === "active_times") {
    useTimes = [];
    useStart = "";
  }

  return { times: useTimes, startAt: useStart, postsPerDay };
}
