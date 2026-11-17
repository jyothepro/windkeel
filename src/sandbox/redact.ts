export const REDACTED = "[REDACTED]";

export const MIN_REDACTABLE_LENGTH = 6;

export function secretForms(value: string): string[] {
  if (value.length < MIN_REDACTABLE_LENGTH) return [];
  const forms = new Set<string>([value]);

  const uri = encodeURIComponent(value);
  if (uri !== value) forms.add(uri);

  const bytes = Buffer.from(value, "utf8");
  for (let offset = 0; offset < 3; offset++) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString("base64");
    const start = Math.ceil((offset * 8) / 6);
    const end = Math.floor(((offset + bytes.length) * 8) / 6);
    const stable = encoded.slice(start, end);
    if (stable.length < MIN_REDACTABLE_LENGTH) continue;
    forms.add(stable);
    forms.add(stable.replace(/\+/g, "-").replace(/\//g, "_"));
  }

  return [...forms].sort((a, b) => b.length - a.length);
}

export function secretRedactor(
  values: Iterable<string> | Readonly<Record<string, string>> | undefined,
): (text: string) => string {
  const list =
    values === undefined
      ? []
      : Symbol.iterator in Object(values)
        ? [...(values as Iterable<string>)]
        : Object.values(values as Readonly<Record<string, string>>);
  const forms = [...new Set(list.flatMap(secretForms))].sort((a, b) => b.length - a.length);
  if (forms.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const form of forms) {
      if (out.includes(form)) out = out.split(form).join(REDACTED);
    }
    return out;
  };
}

export function redactSecrets(
  text: string,
  values: Iterable<string> | Readonly<Record<string, string>> | undefined,
): string {
  return secretRedactor(values)(text);
}

export function redactDeep<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redact)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item, redact);
    return out as T;
  }
  return value;
}
