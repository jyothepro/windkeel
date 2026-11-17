#!/usr/bin/env node
/**
 * Local, real-browser check of the token flow (no Vercel): a headless Chrome opens
 * /__windkeel/open#t=<token>, the bootstrap strips the fragment and exchanges it, the terminal page
 * connects, a command runs, and the cookie / replay / reopen / revoke behaviour is asserted.
 *
 *   CHROME_PATH=/path/to/chrome node browser-check.mjs   (uses playwright-core from the repo root)
 *
 * Uses http://localhost, which browsers treat as a secure context, so the Secure/__Host- cookie
 * behaves as it will on https://<sandbox>.vercel.run.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { mintToken } from "./server/token-gate.mjs";

const port = 38917;
const origin = `http://localhost:${port}`;
const { token, tokenSha256 } = mintToken();
const srv = spawn(process.execPath, [fileURLToPath(new URL("./server/server.mjs", import.meta.url))], {
  env: {
    ...process.env,
    WINDKEEL_WS_TOKEN_SHA256: tokenSha256,
    WINDKEEL_WS_EXPIRES_AT: String(Date.now() + 600_000),
    WINDKEEL_WS_PUBLIC_ORIGIN: origin,
    WINDKEEL_WS_PORT: String(port),
    WINDKEEL_WS_HOST: "127.0.0.1",
    WINDKEEL_WS_SHELL: "/bin/bash",
  },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((r) => srv.stdout.once("data", r));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/404/.test(m.text()) && errors.push(m.text()));

  await page.goto(`${origin}/__windkeel/open#t=${token}`);
  await page.waitForURL(`${origin}/__windkeel/term`, { timeout: 10_000 });
  await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("connected"), null, { timeout: 10_000 });
  await page.click("#term");
  await page.keyboard.type("echo $((6*7))-ok\n");
  await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent.includes("42-ok"), null, { timeout: 10_000 });
  assert.equal(await page.evaluate(() => location.hash), "", "fragment stripped");
  assert.equal(await page.evaluate(() => document.cookie), "", "cookie is HttpOnly");
  const [c] = await ctx.cookies();
  assert.deepEqual([c.name, c.httpOnly, c.secure, c.sameSite, c.path], ["__Host-windkeel_ws", true, true, "Strict", "/"]);
  assert.notEqual(c.value, token, "cookie is not the token");

  const other = await (await browser.newContext()).newPage();
  await other.goto(`${origin}/__windkeel/open#t=${token}`);
  await other.waitForFunction(() => document.getElementById("status").textContent.includes("token already used"), null, { timeout: 5_000 });

  const reopen = await ctx.newPage();
  await reopen.goto(`${origin}/__windkeel/open`);
  await reopen.waitForURL(`${origin}/__windkeel/term`, { timeout: 5_000 });

  await page.click("#end");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("4001"), null, { timeout: 5_000 });
  assert.equal((await reopen.reload()).status(), 410);
  assert.deepEqual(errors, [], "no page errors or CSP violations");
  console.log("browser check: ok (fragment exchange, HttpOnly __Host- cookie, PTY, single-use token, reopen, revoke)");
} finally {
  await browser.close();
  srv.kill();
}
