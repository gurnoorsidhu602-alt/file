// lib/mutex.js
// Per-key async lock. Render runs this service as a single instance, so this
// serialises concurrent requests for the same session (double clicks, two
// tabs). The stores also do a version check as a second line of defence.

const tails = new Map();

export async function withLock(key, fn) {
  const prev = tails.get(key) || Promise.resolve();
  let release;
  const next = new Promise(r => { release = r; });
  const tail = prev.then(() => next);
  tails.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
