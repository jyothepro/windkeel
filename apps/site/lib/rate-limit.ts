export type RateLimiter = {
  check(key: string): { allowed: boolean; retryAfterSeconds: number };
};

export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
  now?: () => number;
  maxKeys?: number;
}): RateLimiter {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;
  const hits = new Map<string, number[]>();

  return {
    check(key) {
      const at = now();
      const since = at - options.windowMs;
      const recent = (hits.get(key) ?? []).filter((time) => time > since);
      if (recent.length >= options.limit) {
        const oldest = recent[0] ?? at;
        hits.set(key, recent);
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + options.windowMs - at) / 1000)) };
      }
      recent.push(at);
      hits.delete(key);
      hits.set(key, recent);
      if (hits.size > maxKeys) {
        const first = hits.keys().next();
        if (!first.done) hits.delete(first.value);
      }
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}

export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || headers.get("x-real-ip") || "unknown";
}
