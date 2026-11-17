export function age(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "not measured";
  return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function time(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function inZone(iso: string, timezone: string): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" };
  try {
    return new Date(iso).toLocaleString("en-US", { ...opts, timeZone: timezone });
  } catch {
    return new Date(iso).toLocaleString("en-US", { ...opts, timeZone: "UTC" });
  }
}
