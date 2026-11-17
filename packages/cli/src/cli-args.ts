

export interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

export const VALUELESS_FLAGS = new Set([
  "gate",
  "follow",
  "json",
  "require-signature",
  "require-tools",
  "sign",
  "force",
  "dry-run",
  "check-hidden",
  "help",
  "admin",
  "no-browser",
  "with-token",
  "enable",
  "disable",
  "all",
  "watch",
  "uncapped-confirmed",
  "csv",
]);

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const equals = body.indexOf("=");
    if (equals !== -1) {
      flags.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const next = argv[i + 1];
    if (!VALUELESS_FLAGS.has(body) && next !== undefined && !next.startsWith("--")) {
      flags.set(body, next);
      i++;
    } else {
      flags.set(body, true);
    }
  }
  return { positional, flags };
}

export const stringFlag = (args: Args, name: string): string | undefined => {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
};
