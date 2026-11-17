#!/usr/bin/env node
import { build } from "esbuild";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "packages", "cli");
const out = join(cli, "release");
const source = JSON.parse(readFileSync(join(cli, "package.json"), "utf8"));
const versionFile = readFileSync(join(root, "packages", "verification", "src", "version.ts"), "utf8");
const toolVersion = /TOOL_VERSION = "([^"]+)"/.exec(versionFile)?.[1];

if (toolVersion !== source.version) {
  console.error(`packages/cli is ${source.version} but TOOL_VERSION is ${toolVersion}; bump both together.`);
  process.exit(2);
}

const tag = process.env.RELEASE_TAG;
if (tag && tag !== `v${source.version}`) {
  console.error(`Tag ${tag} does not match package version ${source.version}.`);
  process.exit(2);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "dist"), { recursive: true });

await build({
  entryPoints: [join(cli, "dist", "cli.js")],
  outfile: join(out, "dist", "cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "none",
  banner: { js: "import { createRequire as __windkeelCreateRequire } from 'node:module'; const require = __windkeelCreateRequire(import.meta.url);" },
});

const shebang = "#!/usr/bin/env node\n";
const bundled = readFileSync(join(out, "dist", "cli.js"), "utf8").replace(/^#!.*\n/gm, "");
writeFileSync(join(out, "dist", "cli.js"), shebang + bundled);
chmodSync(join(out, "dist", "cli.js"), 0o755);

const manifest = {
  name: "windkeel",
  version: source.version,
  description: "Independent verification for AI-written pull requests: run the evidence-based gate locally or in CI, or drive a Windkeel factory.",
  license: "PolyForm-Noncommercial-1.0.0",
  type: "module",
  bin: { windkeel: "dist/cli.js", windkeel: "dist/cli.js" },
  files: ["dist", "README.md", "LICENSE", "NOTICE", "COMMERCIAL.md"],
  engines: source.engines,
  repository: { type: "git", url: "git+https://github.com/jyothepro/windkeel.git", directory: "packages/cli" },
  homepage: "https://github.com/jyothepro/windkeel#readme",
  bugs: { url: "https://github.com/jyothepro/windkeel/issues" },
  keywords: ["ai", "code-review", "verification", "pull-request", "github-action", "coding-agent", "sigstore", "ci"],
};
writeFileSync(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
copyFileSync(join(cli, "README.md"), join(out, "README.md"));
copyFileSync(join(root, "LICENSE"), join(out, "LICENSE"));
copyFileSync(join(root, "NOTICE"), join(out, "NOTICE"));
copyFileSync(join(root, "COMMERCIAL.md"), join(out, "COMMERCIAL.md"));
console.log(`Packed windkeel@${source.version} into ${out}`);
