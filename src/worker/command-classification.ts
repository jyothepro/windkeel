const TEST_BINARIES = new Set([
  "pytest",
  "py.test",
  "jest",
  "vitest",
  "mocha",
  "ava",
  "jasmine",
  "nosetests",
  "tox",
  "phpunit",
  "rspec",
  "ctest",
  "gotestsum",
  "testthat",
]);

const TEST_SUBCOMMANDS: Record<string, Set<string>> = {
  go: new Set(["test"]),
  cargo: new Set(["test", "nextest"]),
  dotnet: new Set(["test"]),
  mvn: new Set(["test"]),
  gradle: new Set(["test", "check"]),
  "./gradlew": new Set(["test", "check"]),
  gradlew: new Set(["test", "check"]),
  rake: new Set(["test", "spec"]),
  swift: new Set(["test"]),
  dart: new Set(["test"]),
  flutter: new Set(["test"]),
  deno: new Set(["test"]),
  bun: new Set(["test"]),
  make: new Set(["test", "check", "tests"]),
  ninja: new Set(["test"]),
};

const SCRIPT_RUNNERS = new Set(["npm", "yarn", "pnpm", "bun"]);

const SINGLE_TOKEN_WRAPPERS = new Set(["sudo", "time", "nice", "npx", "pnpx", "bunx", "xvfb-run"]);
const TWO_TOKEN_WRAPPERS = [
  ["poetry", "run"],
  ["uv", "run"],
  ["pdm", "run"],
  ["hatch", "run"],
  ["bundle", "exec"],
  ["pipenv", "run"],
  ["yarn", "dlx"],
  ["pnpm", "exec"],
  ["pnpm", "dlx"],
  ["npm", "exec"],
] as const;

const TEST_SCRIPT_NAME = /^tests?([:\-_].*)?$/;

export interface CommandClassification {
  isTest: boolean;
  matched?: string;
}

const NOT_A_TEST: CommandClassification = { isTest: false };

const SEGMENT_SPLIT = /\s*(?:&&|\|\||;|\|)\s*/;

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function classifyCommand(command: string, args?: string[]): CommandClassification {
  if (args) return classifyTokens([command, ...args]);
  return command
    .split(SEGMENT_SPLIT)
    .map((segment) => classifyTokens(segment.trim().split(/\s+/)))
    .find((classification) => classification.isTest) ?? NOT_A_TEST;
}

function classifyTokens(rawTokens: string[]): CommandClassification {
  const tokens = stripWrappers(rawTokens.filter((token) => token !== ""));
  const binary = tokens[0];
  if (binary === undefined) return NOT_A_TEST;

  const base = binary.includes("/") ? (binary.split("/").pop() ?? binary) : binary;

  if (TEST_BINARIES.has(base)) return { isTest: true, matched: base };

  if (SCRIPT_RUNNERS.has(base)) return classifyScriptRunner(base, tokens.slice(1));

  const subcommands = TEST_SUBCOMMANDS[binary] ?? TEST_SUBCOMMANDS[base];
  if (subcommands) {
    const subcommand = firstNonFlag(tokens.slice(1));
    if (subcommand !== undefined && subcommands.has(subcommand)) {
      return { isTest: true, matched: `${base} ${subcommand}` };
    }
    return NOT_A_TEST;
  }

  if (base === "python" || base === "python3") {
    const moduleIndex = tokens.indexOf("-m");
    const module = moduleIndex === -1 ? undefined : tokens[moduleIndex + 1];
    if (module === "pytest" || module === "unittest" || module === "nose2") {
      return { isTest: true, matched: `python -m ${module}` };
    }
    return NOT_A_TEST;
  }
  if (base === "node" && tokens.includes("--test")) return { isTest: true, matched: "node --test" };

  return NOT_A_TEST;
}

function classifyScriptRunner(manager: string, rest: string[]): CommandClassification {
  const positional = rest.filter((token) => !token.startsWith("-"));
  const first = positional[0];
  if (first === undefined) return NOT_A_TEST;

  if (first === "run" || first === "run-script") {
    const script = positional[1];
    return script !== undefined && TEST_SCRIPT_NAME.test(script)
      ? { isTest: true, matched: `${manager} run ${script}` }
      : NOT_A_TEST;
  }
  if (manager === "npm" && first === "t") return { isTest: true, matched: "npm t" };
  return TEST_SCRIPT_NAME.test(first)
    ? { isTest: true, matched: `${manager} ${first}` }
    : NOT_A_TEST;
}

function stripWrappers(tokens: string[]): string[] {
  let index = 0;
  for (;;) {
    const token = tokens[index];
    if (token === undefined) break;
    if (ENV_ASSIGNMENT.test(token) || SINGLE_TOKEN_WRAPPERS.has(token)) {
      index += 1;
      continue;
    }
    const next = tokens[index + 1];
    const twoTokenMatch = TWO_TOKEN_WRAPPERS.some(([a, b]) => token === a && next === b);
    if (twoTokenMatch) {
      index += 2;
      continue;
    }
    break;
  }
  return tokens.slice(index);
}

function firstNonFlag(tokens: string[]): string | undefined {
  return tokens.find((token) => !token.startsWith("-"));
}
