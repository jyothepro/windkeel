import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { openPage, runAxe, startSite, type Scheme, type Site } from "./harness.ts";

let site: Site;

before(async () => {
  site = await startSite();
});

after(async () => {
  await site.stop();
});

describe("home", () => {
  test("renders one h1 with no console errors", async () => {
    const { page, context, errors } = await openPage(site, "/");
    assert.equal(await page.locator("h1").count(), 1);
    assert.match((await page.locator("h1").textContent()) ?? "", /Windkeel/);
    assert.match(await page.title(), /Windkeel/);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("every link and anchor resolves", async () => {
    const { page, context } = await openPage(site, "/");
    const hrefs = await page.locator("a[href]").evaluateAll((links) =>
      [...new Set(links.map((link) => link.getAttribute("href") ?? ""))],
    );
    assert.ok(hrefs.length > 10);
    for (const href of hrefs) {
      const target = new URL(href, site.url);
      if (target.origin !== new URL(site.url).origin) continue;
      if (target.hash) {
        const id = target.hash.slice(1);
        const page2 = target.pathname === "/" ? page : null;
        if (page2) assert.equal(await page2.locator(`[id="${id}"]`).count(), 1, `anchor ${href} has no target`);
      }
      const response = await fetch(new URL(target.pathname, site.url));
      assert.equal(response.status, 200, `${href} answered ${response.status}`);
    }
    await context.close();
  });

  test("has metadata, canonical and JSON-LD", async () => {
    const { page, context } = await openPage(site, "/");
    assert.equal(await page.locator('link[rel="canonical"]').getAttribute("href"), "https://windkeel.dev");
    assert.ok(await page.locator('meta[property="og:image"]').getAttribute("content"));
    const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent()) ?? "{}") as { "@type"?: string };
    assert.equal(ld["@type"], "SoftwareApplication");
    for (const path of ["/robots.txt", "/sitemap.xml", "/opengraph-image", "/icon.svg", "/apple-icon"]) {
      assert.equal((await fetch(new URL(path, site.url))).status, 200, path);
    }
    await context.close();
  });

  test("sends the security headers", async () => {
    const response = await fetch(site.url);
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.ok(response.headers.get("referrer-policy"));
    assert.ok(response.headers.get("permissions-policy"));
  });
});

describe("keyboard", () => {
  test("mobile menu opens and closes with the keyboard", async () => {
    const { page, context } = await openPage(site, "/", { width: 390 });
    const trigger = page.getByRole("button", { name: "Open menu" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible" });
    assert.ok(await dialog.evaluate((element) => element.contains(document.activeElement)));
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
    await context.close();
  });

  test("desktop navigation panel opens from the keyboard", async () => {
    const { page, context } = await openPage(site, "/", { width: 1440 });
    const trigger = page.getByRole("button", { name: "Product" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("link", { name: /The evidence package/ }).waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    await context.close();
  });

  test("code tabs switch with arrow keys", async () => {
    const { page, context } = await openPage(site, "/");
    const actionTab = page.getByRole("tab", { name: "GitHub Action" });
    await actionTab.focus();
    await page.keyboard.press("ArrowRight");
    const cliTab = page.getByRole("tab", { name: "CLI" });
    assert.equal(await cliTab.getAttribute("aria-selected"), "true");
    assert.match((await page.getByRole("tabpanel").textContent()) ?? "", /npx windkeel verify/);
    await context.close();
  });

  test("FAQ items open with Enter", async () => {
    const { page, context } = await openPage(site, "/");
    const trigger = page.getByRole("button", { name: "Do you merge pull requests for me?" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    assert.equal(await trigger.getAttribute("aria-expanded"), "true");
    await page.getByText("Windkeel never approves or merges on its own").waitFor({ state: "visible" });
    await page.keyboard.press("Enter");
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    await context.close();
  });

  test("pricing switches between managed and own key with arrow keys", async () => {
    const { page, context } = await openPage(site, "/");
    const managed = page.getByRole("radio", { name: "Windkeel models" });
    await managed.focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.getByRole("radio", { name: "Your own model key" }).getAttribute("aria-checked"), "true");
    await page.getByText("Up to 1,000 sandbox-minutes of compute.").waitFor({ state: "visible" });
    await context.close();
  });

  test("theme toggle sets and remembers the theme", async () => {
    const { page, context } = await openPage(site, "/");
    assert.equal(await page.locator("html").getAttribute("data-theme"), "system");
    await page.getByRole("radio", { name: "System" }).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    await context.close();
  });

  test("copy button shows a toast", async () => {
    const { page, context } = await openPage(site, "/");
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: site.url });
    await page.getByRole("button", { name: "Copy the verify-package command" }).click();
    await page.getByText("Copied to clipboard").waitFor({ state: "visible" });
    await context.close();
  });
});

describe("request access", () => {
  test("the form validates, then submits", async () => {
    const { page, context } = await openPage(site, "/request-access");
    await page.getByRole("button", { name: "Send request" }).click();
    assert.equal(await page.getByText("Request received").count(), 0);
    assert.equal(await page.getByLabel("Work email").evaluate((element) => (element as HTMLInputElement).validity.valid), false);

    await page.getByLabel("Work email").fill("lead@example.com");
    await page.getByLabel("Company").fill("Acme");
    await page.getByLabel("Engineering team size").click();
    await page.getByRole("option", { name: "11 to 50 engineers" }).click();
    await page.getByLabel("Coding agents you use").fill("Claude Code, Codex");
    await page.getByRole("button", { name: "Send request" }).click();
    await page.getByText("Request received").waitFor({ state: "visible" });
    await context.close();
  });

  test("the API rejects bad input, swallows spam and rate-limits", async () => {
    const post = (body: unknown, ip: string) =>
      fetch(new URL("/api/request-access", site.url), {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify(body),
      });
    const bad = await post({ email: "nope" }, "203.0.113.10");
    assert.equal(bad.status, 422);
    const badBody = (await bad.json()) as { fields: Record<string, string> };
    assert.ok(badBody.fields.email);

    const spam = await post({ website: "x" }, "203.0.113.11");
    assert.equal(spam.status, 200);

    const ip = "203.0.113.12";
    const statuses: number[] = [];
    for (let index = 0; index < 6; index += 1) statuses.push((await post({}, ip)).status);
    assert.deepEqual(statuses, [422, 422, 422, 422, 422, 429]);
  });
});

describe("other routes", () => {
  test("unknown paths render the custom 404", async () => {
    const response = await fetch(new URL("/no-such-page", site.url));
    assert.equal(response.status, 404);
    const { page, context } = await openPage(site, "/no-such-page");
    assert.equal(await page.locator("h1").textContent(), "This page is off course.");
    await context.close();
  });

  test("privacy and terms are marked as placeholders", async () => {
    for (const path of ["/privacy", "/terms"]) {
      const { page, context } = await openPage(site, path);
      assert.match((await page.locator("main").textContent()) ?? "", /\[TODO:/);
      await context.close();
    }
  });
});

describe("accessibility", () => {
  const routes = ["/", "/request-access", "/privacy", "/terms", "/no-such-page"];
  const schemes: Scheme[] = ["light", "dark"];
  for (const route of routes) {
    for (const colorScheme of schemes) {
      test(`axe finds no violations on ${route} in ${colorScheme}`, async () => {
        const { page, context } = await openPage(site, route, { colorScheme });
        const violations = await runAxe(page);
        assert.deepEqual(violations, []);
        await context.close();
      });
    }
  }

  test("axe finds no violations with the mobile menu open", async () => {
    const { page, context } = await openPage(site, "/", { width: 390 });
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("dialog").waitFor({ state: "visible" });
    assert.deepEqual(await runAxe(page), []);
    await context.close();
  });

  test("nothing scrolls sideways from 360px to 1440px", async () => {
    for (const width of [360, 390, 768, 1024, 1440]) {
      for (const route of ["/", "/request-access"]) {
        const { page, context } = await openPage(site, route, { width });
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        assert.ok(scrollWidth <= width, `${route} at ${width}px scrolls to ${scrollWidth}px`);
        await context.close();
      }
    }
  });
});
