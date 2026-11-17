export type CronErrorCode = "invalid_cron" | "invalid_timezone";

export class CronError extends Error {
  override readonly name = "CronError";
  constructor(
    message: string,
    readonly code: CronErrorCode = "invalid_cron",
  ) {
    super(message);
  }
}

export interface CronExpression {
  source: string;
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
  repeatsThroughFallBack: boolean;
}

const MACROS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
  nameBase?: number;
}

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  { name: "day-of-week", min: 0, max: 7, names: DAY_NAMES, nameBase: 0 },
];

export function parseCron(text: string): CronExpression {
  if (typeof text !== "string") throw new CronError("a cron expression is a string");
  const source = text.trim();
  if (source === "") throw new CronError("the cron expression is empty");
  const expanded = source.startsWith("@") ? MACROS[source.toLowerCase()] : source;
  if (expanded === undefined) {
    throw new CronError(`unknown macro ${JSON.stringify(source)}; use one of ${Object.keys(MACROS).join(", ")}`);
  }
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError(`a cron expression has 5 fields (minute hour day-of-month month day-of-week); got ${parts.length}`);
  }
  const sets = parts.map((part, i) => parseField(part, FIELDS[i]!));
  const dow = new Set([...sets[4]!].map((d) => (d === 7 ? 0 : d)));
  return {
    source,
    minutes: sets[0]!,
    hours: sets[1]!,
    daysOfMonth: sets[2]!,
    months: sets[3]!,
    daysOfWeek: dow,
    domRestricted: !parts[2]!.startsWith("*"),
    dowRestricted: !parts[4]!.startsWith("*"),
    repeatsThroughFallBack: parts[1]!.startsWith("*"),
  };
}

function parseField(text: string, spec: FieldSpec): Set<number> {
  const out = new Set<number>();
  for (const item of text.split(",")) {
    if (item === "") throw new CronError(`empty list item in the ${spec.name} field`);
    const [range, stepText, extra] = item.split("/");
    if (extra !== undefined) throw new CronError(`"${item}" in the ${spec.name} field has two steps`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
        throw new CronError(`step "${stepText}" in the ${spec.name} field must be a positive whole number`);
      }
      step = Number(stepText);
    }
    let low: number;
    let high: number;
    if (range === "*") {
      low = spec.min;
      high = spec.max;
    } else if (range!.includes("-")) {
      const [a, b, more] = range!.split("-");
      if (more !== undefined) throw new CronError(`"${range}" in the ${spec.name} field is not a range`);
      low = value(a!, spec);
      high = value(b!, spec);
      if (low > high) throw new CronError(`range "${range}" in the ${spec.name} field runs backwards`);
    } else {
      low = value(range!, spec);
      high = stepText !== undefined ? spec.max : low;
    }
    for (let v = low; v <= high; v += step) out.add(v);
  }
  return out;
}

function value(text: string, spec: FieldSpec): number {
  const lower = text.toLowerCase();
  const named = spec.names?.indexOf(lower) ?? -1;
  if (named >= 0) return named + (spec.nameBase ?? 0);
  if (!/^\d+$/.test(text)) throw new CronError(`"${text}" is not a valid ${spec.name}`);
  const n = Number(text);
  if (n < spec.min || n > spec.max) {
    throw new CronError(`${spec.name} ${n} is out of range ${spec.min}-${spec.max}`);
  }
  return n;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function assertTimeZone(timeZone: string): void {
  if (typeof timeZone !== "string" || timeZone.trim() === "") throw new CronError("the time zone is empty", "invalid_timezone");
  try {
    formatter(timeZone);
  } catch {
    throw new CronError(`unknown time zone ${JSON.stringify(timeZone)}; use an IANA name like Europe/London`, "invalid_timezone");
  }
}

function localNaive(ms: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return Date.UTC(parts["year"]!, parts["month"]! - 1, parts["day"], parts["hour"], parts["minute"], parts["second"]);
}

function offsetAt(ms: number, timeZone: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  return localNaive(whole, timeZone) - whole;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WINDOW = 14 * HOUR;

function instantsFor(local: number, timeZone: string, both: boolean): number[] {
  const offsets = new Set([offsetAt(local - WINDOW, timeZone), offsetAt(local + WINDOW, timeZone)]);
  const valid = [...offsets]
    .map((o) => local - o)
    .filter((instant) => offsetAt(instant, timeZone) === local - instant)
    .sort((a, b) => a - b);
  if (valid.length === 0) {
    return [local - offsetAt(local - WINDOW, timeZone)];
  }
  return both ? valid : [valid[0]!];
}

function dayMatches(expr: CronExpression, d: Date): boolean {
  const dom = expr.daysOfMonth.has(d.getUTCDate());
  const dow = expr.daysOfWeek.has(d.getUTCDay());
  if (expr.domRestricted && expr.dowRestricted) return dom || dow;
  return dom && dow;
}

const SEARCH_YEARS = 30;

function nextLocal(expr: CronExpression, from: number): number | null {
  let t = Math.ceil(from / MINUTE) * MINUTE;
  const limitYear = new Date(t).getUTCFullYear() + SEARCH_YEARS;
  for (;;) {
    const d = new Date(t);
    const year = d.getUTCFullYear();
    if (year > limitYear) return null;
    const month0 = d.getUTCMonth();
    if (!expr.months.has(month0 + 1)) {
      t = Date.UTC(year, month0 + 1, 1);
      continue;
    }
    if (!dayMatches(expr, d)) {
      t = Date.UTC(year, month0, d.getUTCDate() + 1);
      continue;
    }
    if (!expr.hours.has(d.getUTCHours())) {
      t = Date.UTC(year, month0, d.getUTCDate(), d.getUTCHours() + 1);
      continue;
    }
    if (!expr.minutes.has(d.getUTCMinutes())) {
      t += MINUTE;
      continue;
    }
    return t;
  }
}

export function nextFireTime(expr: CronExpression | string, after: Date, timeZone: string): Date | null {
  const e = typeof expr === "string" ? parseCron(expr) : expr;
  assertTimeZone(timeZone);
  const afterMs = after.getTime();
  const nearTransition = offsetAt(afterMs - 3 * HOUR, timeZone) !== offsetAt(afterMs + 3 * HOUR, timeZone);
  const margin = nearTransition ? 3 * HOUR : 0;

  let cursor = Math.floor(localNaive(afterMs, timeZone) / MINUTE) * MINUTE + MINUTE - margin;
  let best: number | null = null;
  let bestLocal = 0;
  for (let guard = 0; guard < 100_000; guard++) {
    const local = nextLocal(e, cursor);
    if (local === null) break;
    if (best !== null && local > bestLocal + margin) break;
    for (const instant of instantsFor(local, timeZone, e.repeatsThroughFallBack)) {
      if (instant > afterMs && (best === null || instant < best)) {
        best = instant;
        bestLocal = local;
      }
    }
    if (best !== null && margin === 0) break;
    cursor = local + MINUTE;
  }
  return best === null ? null : new Date(best);
}

export function nextFireTimes(expr: CronExpression | string, after: Date, timeZone: string, count: number): Date[] {
  const e = typeof expr === "string" ? parseCron(expr) : expr;
  const out: Date[] = [];
  let cursor = after;
  while (out.length < count) {
    const next = nextFireTime(e, cursor, timeZone);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

export function latestFireTimeAtOrBefore(
  expr: CronExpression | string,
  notBefore: Date,
  at: Date,
  timeZone: string,
): Date {
  const e = typeof expr === "string" ? parseCron(expr) : expr;
  const atMs = at.getTime();
  if (notBefore.getTime() > atMs) return notBefore;
  for (const window of [HOUR, DAY, 32 * DAY, 367 * DAY, 30 * 367 * DAY]) {
    const from = Math.max(notBefore.getTime(), atMs - window);
    let slot = from === notBefore.getTime() ? notBefore : nextFireTime(e, new Date(from - 1), timeZone);
    if (!slot || slot.getTime() > atMs) {
      if (from === notBefore.getTime()) return notBefore;
      continue;
    }
    for (;;) {
      const next = nextFireTime(e, slot, timeZone);
      if (!next || next.getTime() > atMs) return slot;
      slot = next;
    }
  }
  return notBefore;
}

export function localDate(at: Date, timeZone: string): string {
  return new Date(localNaive(at.getTime(), timeZone)).toISOString().slice(0, 10);
}

export function validateSchedule(
  cron: string,
  timeZone: string,
  now = new Date(),
): { expr: CronExpression; next: Date } {
  const expr = parseCron(cron);
  assertTimeZone(timeZone);
  const next = nextFireTime(expr, now, timeZone);
  if (!next) throw new CronError(`"${cron}" never fires (no date matches it)`);
  return { expr, next };
}
