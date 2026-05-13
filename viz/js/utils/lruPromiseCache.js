// LRU-bounded cache that stores Promises by key. The factory is invoked at
// most once per (still-cached) key — concurrent callers share the same
// in-flight Promise. On rejection the entry is evicted so a transient
// network/backend hiccup doesn't permanently poison the cache.
//
// Touch-on-access keeps the most recently used entries alive: when we hit
// the configured limit, the oldest entry is evicted via Map insertion order.
// JavaScript Map preserves insertion order, so re-inserting on access bumps
// an entry to the "tail" of the iteration — i.e. most recently used.

export function createLruPromiseCache(limit = 64) {
  const entries = new Map();

  return {
    getOrCompute(key, factory) {
      if (entries.has(key)) {
        const cached = entries.get(key);
        // Refresh recency: re-insert at the tail.
        entries.delete(key);
        entries.set(key, cached);
        return cached;
      }

      const promise = factory();
      entries.set(key, promise);

      // Evict failed entries so callers retry next time. Guard against
      // racing replacements — only delete if this exact Promise still owns
      // the key.
      promise.catch(() => {
        if (entries.get(key) === promise) {
          entries.delete(key);
        }
      });

      while (entries.size > limit) {
        const oldestKey = entries.keys().next().value;
        entries.delete(oldestKey);
      }

      return promise;
    },

    size() {
      return entries.size;
    },

    clear() {
      entries.clear();
    },
  };
}
