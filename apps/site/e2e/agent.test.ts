import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startSite, type Site } from "./harness.ts";

type Entry = { ref: string; component: string; label?: string; offPage?: boolean; items?: { value: string; label: string }[] };

let site: Site;

before(async () => {
  site = await startSite();
});

after(async () => {
  await site.stop();
});

const STUB = `
  window.__tools = {};
  Object.defineProperty(document, "modelContext", {
    value: { registerTool(tool) { window.__tools[tool.name] = tool; return Promise.resolve(); } },
  });
`;

async function openWithAgent(path: string, width = 1440) {
  const context = await site.browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  await context.addInitScript({ content: STUB });
  const page = await context.newPage();
  await page.goto(new URL(path, site.url).toString(), { waitUntil: "networkidle" });
  await page.waitForFunction(() => Object.keys((window as unknown as { __tools: object }).__tools).length >= 3);
  const call = (name: string, input: unknown) =>
    page.evaluate(
      async ([toolName, toolInput]) => {
        const tools = (window as unknown as { __tools: Record<string, { execute: (input: unknown) => unknown }> }).__tools;
        const tool = tools[toolName];
        if (!tool) throw new Error(`no tool ${String(toolName)}`);
        const result = await tool.execute(toolInput);
        return JSON.parse(JSON.stringify(result)) as unknown;
      },
      [name, input] as const,
    );
  return { page, context, call };
}

function entriesOf(result: unknown): Entry[] {
  if (Array.isArray(result)) return result as Entry[];
  const text = (result as { content?: { text?: string }[] }).content?.[0]?.text;
  if (text) {
    const parsed = JSON.parse(text) as unknown;
    return entriesOf(parsed);
  }
  const components = (result as { components?: Entry[] }).components;
  if (components) return components;
  throw new Error(`unexpected snapshot shape: ${JSON.stringify(result).slice(0, 300)}`);
}

function okOf(result: unknown): { ok: boolean; message?: string } {
  const text = (result as { content?: { text?: string }[] }).content?.[0]?.text;
  const value = (text ? JSON.parse(text) : result) as { ok?: boolean; error?: { message?: string } };
  return { ok: value.ok === true, message: value.error?.message };
}

test("an agent can find and use every interactive control on the home page", async () => {
  const { page, context, call } = await openWithAgent("/");
  const entries = entriesOf(await call("snapshot", {})).filter((entry) => !entry.offPage && entry.component !== "more");
  for (const entry of entries) assert.ok(entry.label, `${entry.component} ${entry.ref} has no name`);
  const labels = entries.map((entry) => entry.label ?? "");
  for (const label of ["Main", "Color theme", "Ways to run Gate", "Which models run your work", "Frequently asked questions"]) {
    assert.ok(labels.some((name) => name === label), `${label} is missing from the snapshot: ${labels.join(", ")}`);
  }

  const result = okOf(
    await call("act", {
      steps: [
        { ref: "Which models run your work", action: "setValue", args: ["byok"] },
        { ref: "Ways to run Gate", action: "setValue", args: ["cli"] },
        { ref: "Color theme", action: "setValue", args: ["dark"] },
      ],
    }),
  );
  assert.ok(result.ok, result.message);
  await page.getByText("Up to 1,000 sandbox-minutes of compute.").waitFor({ state: "visible" });
  assert.equal(await page.getByRole("tab", { name: "CLI" }).getAttribute("aria-selected"), "true");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await context.close();
});

test("an agent can fill and send the request-access form", async () => {
  const { page, context, call } = await openWithAgent("/request-access");
  const entries = entriesOf(await call("snapshot", {})).filter((entry) => !entry.offPage && entry.component !== "more");
  const labels = entries.map((entry) => entry.label ?? "");
  for (const label of ["Work email", "Company", "Engineering team size", "Coding agents you use", "Send request"]) {
    assert.ok(labels.includes(label), `${label} is missing from the snapshot: ${labels.join(", ")}`);
  }
  const result = okOf(
    await call("act", {
      steps: [
        { ref: "Work email", action: "setValue", args: ["agent@example.com"] },
        { ref: "Company", action: "setValue", args: ["Acme"] },
        { ref: "Engineering team size", action: "setValue", args: ["51-200"] },
        { ref: "Coding agents you use", action: "setValue", args: ["OpenCode"] },
        { ref: "Send request", action: "press", args: [] },
      ],
    }),
  );
  assert.ok(result.ok, result.message);
  await page.getByText("Request received").waitFor({ state: "visible" });
  await context.close();
});
