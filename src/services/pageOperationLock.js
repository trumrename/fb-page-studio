/** Per-page lock. Burst of 3 videos on one page may run in parallel (maxConcurrent). */
const sem = new Map();

export async function withPageOperationLock(pageRowId, fn, opts = {}) {
  const key = String(pageRowId || "unknown");
  const max = Math.max(1, Math.min(6, Number(opts.maxConcurrent) || 1));
  let s = sem.get(key);
  if (!s) {
    s = { active: 0, q: [] };
    sem.set(key, s);
  }
  if (s.active >= max) {
    await new Promise((resolve) => s.q.push(resolve));
  }
  s.active += 1;
  try {
    return await fn();
  } finally {
    s.active -= 1;
    const next = s.q.shift();
    if (next) next();
    else if (s.active <= 0) sem.delete(key);
  }
}
