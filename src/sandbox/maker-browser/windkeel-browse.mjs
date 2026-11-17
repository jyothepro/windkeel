#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);
const MAX_CONSOLE_ERRORS = 20;
const MAX_TEXT = 500;

const out = resolve(process.env.WINDKEEL_BROWSER_OUT || join(process.cwd(), ".windkeel", "browser"));

function fail(code, message) {
  process.stderr.write(`windkeel-browse: ${message}\n`);
  process.exit(code);
}

function localUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  return LOCAL_HOSTS.has(url.hostname) ? url : null;
}

function cut(text) {
  const s = String(text ?? "").replace(/[\u0000-\u001f\u007f]/g, " ");
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      flags["--"] = argv.slice(i + 1);
      break;
    }
    if (arg === "--full-page") flags.fullPage = true;
    else if (arg === "--name" || arg === "--wait-for" || arg === "--viewport" || arg === "--port" || arg === "--timeout") {
      const value = argv[++i];
      if (value === undefined) fail(64, `${arg} needs a value`);
      flags[arg.slice(2)] = value;
    } else if (arg.startsWith("--")) fail(64, `unknown option ${arg}`);
    else positional.push(arg);
  }
  return { positional, flags };
}

async function chromium() {
  try {
    return (await import("playwright-core")).chromium;
  } catch (error) {
    fail(3, `browser_unavailable: playwright-core is not installed (${cut(error?.message)})`);
  }
}

async function screenshot(rawUrl, flags) {
  const url = localUrl(rawUrl);
  if (!url) fail(2, `url_not_local: ${cut(rawUrl)} — only http:// on localhost, 127.0.0.1, 0.0.0.0 or [::1] is allowed`);
  const name = (flags.name ?? "page").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "").slice(0, 60) || "page";
  let viewport = { width: 1280, height: 800 };
  if (flags.viewport) {
    const m = /^(\d{2,5})x(\d{2,5})$/.exec(flags.viewport);
    if (!m) fail(64, "--viewport must look like 1280x800");
    viewport = { width: Math.min(Number(m[1]), 4000), height: Math.min(Number(m[2]), 4000) };
  }

  mkdirSync(out, { recursive: true });
  const seq = readdirSync(out).filter((f) => f.endsWith(".png")).length + 1;
  const file = `${String(seq).padStart(3, "0")}-${name}.png`;
  const path = join(out, file);

  const launcher = await chromium();
  let browser;
  try {
    browser = await launcher.launch();
  } catch (error) {
    fail(3, `browser_unavailable: Chromium did not start (${cut(error?.message)})`);
  }
  const consoleErrors = [];
  let status = null;
  let title = "";
  try {
    const page = await browser.newPage({ viewport });
    page.on("console", (msg) => {
      if (msg.type() === "error" && consoleErrors.length < MAX_CONSOLE_ERRORS) consoleErrors.push(cut(msg.text()));
    });
    page.on("pageerror", (error) => {
      if (consoleErrors.length < MAX_CONSOLE_ERRORS) consoleErrors.push(cut(`Uncaught ${error?.message ?? error}`));
    });
    await page.route("**/*", (route) => {
      const target = route.request().url();
      if (/^(data|blob|about):/.test(target) || localUrl(target)) return route.continue();
      return route.abort("blockedbyclient");
    });
    try {
      const response = await page.goto(url.href, { waitUntil: "load", timeout: 30_000 });
      status = response ? response.status() : null;
    } catch (error) {
      fail(3, `could not load ${url.href}: ${cut(error?.message)}`);
    }
    if (flags["wait-for"]) {
      try {
        await page.waitForSelector(flags["wait-for"], { timeout: 15_000 });
      } catch {
        consoleErrors.push(cut(`windkeel-browse: ${flags["wait-for"]} did not appear within 15s`));
      }
    }
    title = cut(await page.title().catch(() => ""));
    await page.screenshot({ path, fullPage: flags.fullPage === true });
  } finally {
    await browser.close().catch(() => {});
  }

  const entry = { file, name, url: url.href, title, status, consoleErrors, at: new Date().toISOString() };
  appendFileSync(join(out, "index.jsonl"), `${JSON.stringify(entry)}\n`);
  const lines = [
    `screenshot: ${path}`,
    `url: ${url.href}`,
    `status: ${status ?? "none"}`,
    `title: ${title}`,
    `console errors: ${consoleErrors.length}`,
    ...consoleErrors.map((e) => `  - ${e}`),
    "(For your own check only: a maker screenshot is not verification evidence.)",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function portOpen(port) {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      done(true);
    });
    socket.on("error", () => done(false));
  });
}

async function serve(flags) {
  const command = flags["--"];
  if (!command?.length) fail(64, "serve needs a command after --");
  const port = flags.port ? Number(flags.port) : 3000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(64, "--port must be 1-65535");
  const timeout = (flags.timeout ? Number(flags.timeout) : 90) * 1000;
  mkdirSync(out, { recursive: true });
  const child = spawn(command[0], command.slice(1), { detached: true, stdio: "ignore" });
  child.unref();
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await portOpen(port)) {
      process.stdout.write(`serving: pid ${child.pid} on http://127.0.0.1:${port}\n`);
      return;
    }
    if (child.exitCode !== null) fail(1, `${command[0]} exited ${child.exitCode} before port ${port} opened`);
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(1, `nothing listened on port ${port} within ${timeout / 1000}s (pid ${child.pid} left running)`);
}

async function check() {
  const launcher = await chromium();
  try {
    const browser = await launcher.launch();
    await browser.close();
  } catch (error) {
    fail(3, `browser_unavailable: Chromium did not start (${cut(error?.message)})`);
  }
  process.stdout.write("browser: ok\n");
}

const [command, ...rest] = process.argv.slice(2);
const { positional, flags } = parseArgs(rest);
if (command === "screenshot" && positional.length === 1) await screenshot(positional[0], flags);
else if (command === "serve") await serve(flags);
else if (command === "check") await check();
else {
  fail(
    64,
    "usage: windkeel-browse screenshot <url> [--name n] [--full-page] [--wait-for selector] [--viewport WxH]\n" +
      "       windkeel-browse serve [--port p] [--timeout s] -- <command...>\n" +
      "       windkeel-browse check",
  );
}
