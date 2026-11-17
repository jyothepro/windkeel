import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);

export type Site = { url: string; browser: Browser; stop(): Promise<void> };

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`site did not start at ${url}`);
}

export async function startSite(): Promise<Site> {
  let server: ChildProcess | undefined;
  let url = process.env.SITE_URL;
  if (!url) {
    const port = 3300 + Math.floor(Math.random() * 500);
    url = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--port", String(port), "--hostname", "127.0.0.1"], {
      cwd: appDir,
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, NODE_ENV: "production" },
    });
    await waitFor(url, 30_000);
  }
  const executablePath = process.env.CHROMIUM_EXECUTABLE || undefined;
  const browser = await chromium.launch({ executablePath });
  return {
    url,
    browser,
    async stop() {
      await browser.close();
      if (server && server.exitCode === null) {
        const exited = new Promise((resolve) => server?.once("exit", resolve));
        server.kill("SIGTERM");
        await exited;
      }
    },
  };
}

export type Scheme = "light" | "dark";

export async function openPage(
  site: Site,
  path: string,
  options: { width?: number; colorScheme?: Scheme } = {},
): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
  const context = await site.browser.newContext({
    viewport: { width: options.width ?? 1280, height: 900 },
    colorScheme: options.colorScheme ?? "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(new URL(path, site.url).toString(), { waitUntil: "networkidle" });
  return { page, context, errors };
}

const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

export type AxeViolation = { id: string; impact: string | null; help: string; nodes: { target: string[] }[] };

export async function runAxe(page: Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ content: axeSource });
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (context: Document, options: object) => Promise<{ violations: AxeViolation[] }> } }).axe;
    const result = await axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
    });
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({ target: node.target })),
    }));
  });
}
