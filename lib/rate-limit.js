/** Fixed-window in-process rate limiter keyed by caller-chosen buckets. */
export class SlidingWindow {
  constructor(limit, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  /** Record one hit; returns false when the bucket is already at its limit. */
  take(key, now = Date.now()) {
    const cutoff = now - this.windowMs;
    let entries = this.hits.get(key);
    if (entries === undefined) {
      entries = [];
      this.hits.set(key, entries);
    }
    while (entries.length > 0 && entries[0] <= cutoff) entries.shift();
    if (entries.length >= this.limit) return false;
    entries.push(now);
    return true;
  }

  /** Drop expired buckets so long-lived hosts do not accumulate keys. */
  prune(now = Date.now()) {
    const cutoff = now - this.windowMs;
    for (const [key, entries] of this.hits) {
      while (entries.length > 0 && entries[0] <= cutoff) entries.shift();
      if (entries.length === 0) this.hits.delete(key);
    }
  }
}
