

import type { SandboxHandle } from "../provider.js";
import { APT_OVER_HTTPS, NOT_ISOLATED, elevated, elevation } from "../system-tools.js";
import { WINDKEEL_BROWSE_SOURCE } from "./windkeel-browse-source.js";

export const MAKER_BROWSER_PLAYWRIGHT_VERSION = "1.65.0";

export const MAKER_BROWSER_OUT_DIR = ".windkeel/browser";

export type MakerBrowserState =
  | {
      status: "installed";

      helper: string;
      startCommand?: string;
      port?: number;
      durationMs: number;
    }
  | { status: "unavailable"; reason: string; durationMs: number };

export interface MakerBrowserInstallOptions {

  isolated: boolean;

  startCommand?: string | undefined;
  port?: number | undefined;
}

const tail = (text: string) => text.trim().slice(-300);

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function installMakerBrowser(
  handle: SandboxHandle,
  options: MakerBrowserInstallOptions,
): Promise<MakerBrowserState> {
  const started = Date.now();
  const unavailable = (reason: string): MakerBrowserState => ({
    status: "unavailable",
    reason: reason.slice(0, 1000),
    durationMs: Date.now() - started,
  });
  if (handle.role !== "maker") return unavailable("the browser is the maker's; a verifier sandbox never gets one");
  if (!options.isolated) return unavailable(`Chromium was not installed: ${NOT_ISOLATED}`);

  try {
    const dir = await handle.mkdtemp("windkeel-maker-browser-");
    await handle.writeFile(`${dir}/windkeel-browse.mjs`, WINDKEEL_BROWSE_SOURCE);
    await handle.writeFile(`${dir}/package.json`, `${JSON.stringify({ private: true, type: "module" })}\n`);

    const npm = await handle.exec("npm", {
      args: [
        "install",
        "--prefix",
        dir,
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
        `playwright-core@${MAKER_BROWSER_PLAYWRIGHT_VERSION}`,
      ],
      env: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
    });
    if (npm.status !== 0 || npm.error) {
      return unavailable(`npm could not install playwright-core: ${npm.error ?? `exit ${npm.status}: ${tail(npm.stderr)}`}`);
    }

    const cli = `${dir}/node_modules/playwright-core/cli.js`;
    const browsers = `${dir}/browsers`;

    const prefix = await elevation(handle);
    const nodeBin = (await handle.exec("sh", { args: ["-c", "command -v node"] })).stdout.trim() || "node";
    await elevated(handle, prefix, "sh", ["-c", APT_OVER_HTTPS]);
    await elevated(handle, prefix, nodeBin, [cli, "install-deps", "chromium-headless-shell"]);

    const chromium = await handle.exec(nodeBin, {
      args: [cli, "install", "chromium-headless-shell"],
      env: { PLAYWRIGHT_BROWSERS_PATH: browsers },
    });
    if (chromium.status !== 0 || chromium.error) {
      return unavailable(
        `Chromium could not be downloaded: ${chromium.error ?? `exit ${chromium.status}: ${tail(chromium.stderr || chromium.stdout)}`}`,
      );
    }

    const helper = `${dir}/bin/windkeel-browse`;
    const out = `${handle.checkoutPath.replace(/\/+$/, "")}/${MAKER_BROWSER_OUT_DIR}`;
    await handle.exec("mkdir", { args: ["-p", `${dir}/bin`] });
    await handle.writeFile(
      helper,
      [
        "#!/bin/sh",
        "# windkeel-browse: the maker's headless browser (#392). Screenshots are not verification evidence.",
        `export PLAYWRIGHT_BROWSERS_PATH=${shellQuote(browsers)}`,
        `export WINDKEEL_BROWSER_OUT=${shellQuote(out)}`,
        `exec ${shellQuote(nodeBin)} ${shellQuote(`${dir}/windkeel-browse.mjs`)} "$@"`,
        "",
      ].join("\n"),
    );
    await handle.exec("chmod", { args: ["755", helper] });

    const check = await handle.exec(helper, { args: ["check"] });
    if (check.status !== 0 || check.error) {
      return unavailable(`Chromium was installed but does not start: ${check.error ?? tail(check.stderr || check.stdout)}`);
    }

    await elevated(handle, prefix, "ln", ["-sf", helper, "/usr/local/bin/windkeel-browse"]);

    return {
      status: "installed",
      helper,
      ...(options.startCommand ? { startCommand: options.startCommand } : {}),
      ...(options.port ? { port: options.port } : {}),
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return unavailable(`the browser install failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function excludeMakerBrowserOutput(handle: SandboxHandle): Promise<void> {
  const line = `/${MAKER_BROWSER_OUT_DIR}/`;
  await handle
    .exec("sh", {
      args: [
        "-c",
        'f="$(git rev-parse --git-path info/exclude)" && mkdir -p "$(dirname "$f")" && ' +
          '{ grep -qxF "$WINDKEEL_LINE" "$f" 2>/dev/null || printf "%s\\n" "$WINDKEEL_LINE" >> "$f"; }',
      ],
      cwd: handle.checkoutPath,
      env: { WINDKEEL_LINE: line },
    })
    .catch(() => undefined);
}
