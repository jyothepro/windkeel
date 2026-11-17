import tseslint from "typescript-eslint";
import windkeel from "./tools/eslint-plugin-windkeel/index.js";

const SOURCE = [
  "src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
  "packages/*/src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
  "apps/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
  "tools/**/*.{js,mjs}",
  "eslint.config.js",
];

const GENERATED_OR_BUILT = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.next/**",
  "**/.vercel/**",
  "**/.swc/**",
  "src/.well-known/**",
  "apps/console/next-env.d.ts",
  "apps/site/next-env.d.ts",
  "src/sandbox/human-workspace-server-files.ts",
  "src/sandbox/maker-browser/windkeel-browse-source.ts",
];



const ANY_NOT_YET_TYPED = ["src/github/user-client.ts"];

const PURE_FILES = [
  "src/factory/run-state-machine.ts",
  "src/factory/rails.ts",
  "src/factory/merge-eligibility.ts",
  "src/factory/knowledge-risk.ts",
  "src/github/summary.ts",
];

export default [
  { ignores: GENERATED_OR_BUILT },
  {
    files: SOURCE,
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    plugins: { windkeel },
    rules: {
      "windkeel/no-comments": "error",
      "windkeel/no-direct-run-status-write": "error",
      "windkeel/flow-imports-only-sleep": "error",
      "windkeel/no-ambient-nondeterminism": ["error", { pureFiles: PURE_FILES }],
      "windkeel/console-no-server-imports": "error",
      "windkeel/reviewer-output-floor": "error",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            { from: "package", package: "node:test", name: ["test", "it", "describe", "suite"] },
          ],
        },
      ],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],
    },
  },
  {
    files: ["apps/console/**/*.test.ts", "apps/console/scripts/**"],
    rules: { "windkeel/console-no-server-imports": "off" },
  },
  { files: ANY_NOT_YET_TYPED, rules: { "@typescript-eslint/no-explicit-any": "off" } },
];
