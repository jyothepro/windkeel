/**
 * A fake Jira Cloud (one or more sites) behind an injected `fetch`, for the M8-8 tests. No test
 * reaches the network. It implements exactly the calls `src/integrations/jira.ts` makes.
 */

const DAY = 24 * 60 * 60 * 1000;

export class FakeJira {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** cloudId → { siteUrl, projects, webhooks: Map<id, {...}>, comments: Map<key, body[]> } */
    this.sites = new Map();
    this.nextId = 1001;
    this.calls = [];
    /** `${method} ${op}` → status to answer once (e.g. "POST webhook" → 500). */
    this.failOnce = new Map();
    /** Answer every request with this status (a site that is down). */
    this.failAll = null;
    /** Never answer (a site that hangs); only an AbortSignal ends a request. */
    this.hang = false;
    /** `${method} ${op}` → a gate the next such request waits at (see `pause`). */
    this.gates = new Map();
    this.fetch = this.fetch.bind(this);
  }

  /**
   * Holds the next `${method} ${op}` request (e.g. "GET webhook") until `release()`: a slow Jira in
   * the middle of an `ensure`, so a test can act while that `ensure` holds the connection.
   */
  pause(key) {
    let release;
    let reached;
    const released = new Promise((resolve) => (release = resolve));
    const arrived = new Promise((resolve) => (reached = resolve));
    this.gates.set(key, { released, reached });
    return { arrived, release };
  }

  site(cloudId, { siteUrl = `https://${cloudId}.atlassian.net`, projects = ["ENG", "OPS"] } = {}) {
    this.sites.set(cloudId, { siteUrl, projects, webhooks: new Map(), comments: new Map() });
    return this;
  }

  /** Jira dropping a webhook (expired past its grace, or removed). */
  drop(cloudId, id) {
    this.sites.get(cloudId).webhooks.delete(id);
  }

  webhooksOf(cloudId) {
    return [...this.sites.get(cloudId).webhooks.values()];
  }

  commentsOn(cloudId, key) {
    return this.sites.get(cloudId).comments.get(key) ?? [];
  }

  async fetch(input, init = {}) {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const auth = init.headers?.authorization ?? "";
    const body = init.body ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, path: url.pathname + url.search, auth, body, signal: init.signal });
    if (this.hang) {
      // A Jira that never answers: only the caller's signal ends the request.
      return new Promise((_, reject) => {
        const abort = () => reject(init.signal.reason ?? new DOMException("aborted", "AbortError"));
        if (!init.signal) return;
        if (init.signal.aborted) abort();
        else init.signal.addEventListener("abort", abort, { once: true });
      });
    }
    // Yield once, so concurrent callers interleave the way they would over a network.
    await new Promise((resolve) => setImmediate(resolve));
    if (!auth.startsWith("Bearer ")) return json(401, {});
    if (this.failAll) return json(this.failAll, { errorMessages: ["secret-ish failure detail"] });

    if (url.pathname === "/oauth/token/accessible-resources") {
      return json(200, [...this.sites].map(([id, s]) => ({ id, url: s.siteUrl, name: id })));
    }
    const m = /^\/ex\/jira\/([^/]+)(\/rest\/api\/3\/.*)$/.exec(url.pathname);
    if (!m) return json(404, {});
    const site = this.sites.get(decodeURIComponent(m[1]));
    if (!site) return json(404, {});
    const path = m[2];
    const op =
      path === "/rest/api/3/webhook" ? "webhook"
      : path === "/rest/api/3/webhook/refresh" ? "refresh"
      : path === "/rest/api/3/project/search" ? "projects"
      : /\/comment$/.test(path) ? "comment"
      : path;
    const gate = this.gates.get(`${method} ${op}`);
    if (gate) {
      this.gates.delete(`${method} ${op}`);
      gate.reached();
      await gate.released;
    }
    const failure = this.failOnce.get(`${method} ${op}`);
    if (failure) {
      this.failOnce.delete(`${method} ${op}`);
      return json(failure, { errorMessages: ["boom"] });
    }

    if (op === "webhook" && method === "GET") {
      const values = [...site.webhooks.values()].map((w) => ({
        id: w.id,
        jqlFilter: w.jqlFilter,
        events: w.events,
        expirationDate: w.expirationDate,
      }));
      return json(200, { startAt: 0, maxResults: 100, total: values.length, isLast: true, values });
    }
    if (op === "webhook" && method === "POST") {
      const results = body.webhooks.map((w) => {
        const id = this.nextId++;
        site.webhooks.set(id, { id, url: body.url, ...w, expirationDate: this.now() + 30 * DAY });
        return { createdWebhookId: id };
      });
      return json(200, { webhookRegistrationResult: results });
    }
    if (op === "webhook" && method === "DELETE") {
      for (const id of body.webhookIds) site.webhooks.delete(id);
      return new Response(null, { status: 202 });
    }
    if (op === "refresh" && method === "PUT") {
      const expirationDate = this.now() + 30 * DAY;
      for (const id of body.webhookIds) {
        const w = site.webhooks.get(id);
        if (w) w.expirationDate = expirationDate;
      }
      return json(200, { expirationDate });
    }
    if (op === "projects") {
      // Paged like Jira's: `startAt` / `maxResults`, `isLast` on the final page.
      const startAt = Number(url.searchParams.get("startAt") ?? 0);
      const maxResults = Number(url.searchParams.get("maxResults") ?? 50);
      const values = site.projects.slice(startAt, startAt + maxResults).map((key) => ({ key }));
      return json(200, { isLast: startAt + maxResults >= site.projects.length, values });
    }
    if (op === "comment") {
      const key = decodeURIComponent(path.split("/")[5]);
      const list = site.comments.get(key) ?? [];
      if (method === "GET") {
        return json(200, { comments: [...list].reverse().map((b, i) => ({ id: String(i), body: b })) });
      }
      list.push(body.body);
      site.comments.set(key, list);
      return json(201, { id: String(list.length) });
    }
    return json(404, {});
  }
}

function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

export { DAY };
