// Runs `items` through `worker` with at most `concurrency` in flight at once.
// This is a logical concurrency pool (Promise-based), not literal OS threads —
// see README for why real Web Workers weren't used here.
export async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runNext() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (err) {
        results[index] = { ok: false, error: err };
      }
    }
  }

  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, runNext);
  await Promise.all(lanes);
  return results;
}
