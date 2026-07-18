/** Serialize media/caption selection and Graph publishing for each Page. */
const tails = new Map();

export async function withPageOperationLock(pageRowId, fn) {
  const key = String(pageRowId || "unknown");
  const previous = tails.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  tails.set(key, current);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === current) tails.delete(key);
  }
}
