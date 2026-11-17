/**
 * A fake of the one Sentry API call Windkeel makes (#389): `POST /api/0/issues/{id}/comments/`.
 *
 * Records every comment per issue with the bearer it came with, refuses a bearer it was not told
 * about (401), and answers 429/5xx on demand (`failNext`) so the notifier's bounded retry can be
 * exercised. Anything else — another path, another host — throws: no test reaches the network.
 */

export const SENTRY_HOST = "sentry.io";

export class FakeSentry {
  constructor({ tokens = ["sntrys_fake_token_0123456789"] } = {}) {
    this.tokens = new Set(tokens);
    /** @type {Array<{ issueId: string; text: string; authorization: string }>} */
    this.comments = [];
    /** Every request, accepted or not. */
    this.requests = [];
    /** Statuses to answer, in order, before accepting again (e.g. [429, 503]). */
    this.queue = [];
    /** Answer every request with this status while set. */
    this.failAll = null;
    this.fetch = this.fetch.bind(this);
  }

  /** The next `statuses.length` requests answer these statuses; a 429 carries `Retry-After: 0`. */
  failNext(...statuses) {
    this.queue.push(...statuses);
    return this;
  }

  commentsOn(issueId) {
    return this.comments.filter((c) => c.issueId === issueId).map((c) => c.text);
  }

  async fetch(url, init = {}) {
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("aborted", "AbortError");
    const parsed = new URL(url);
    if (parsed.host !== SENTRY_HOST) throw new Error(`no network in tests: ${url}`);
    const match = /^\/api\/0\/issues\/([^/]+)\/comments\/$/.exec(parsed.pathname);
    if (!match || init.method !== "POST") throw new Error(`FakeSentry does not answer ${init.method} ${parsed.pathname}`);
    const authorization = init.headers?.authorization ?? "";
    this.requests.push({ url, authorization });
    const status = this.failAll ?? this.queue.shift();
    if (status !== undefined && status !== null) {
      return new Response(JSON.stringify({ detail: "fake failure" }), {
        status,
        headers: status === 429 ? { "retry-after": "0" } : {},
      });
    }
    const token = authorization.replace(/^Bearer /, "");
    if (!this.tokens.has(token)) return new Response(JSON.stringify({ detail: "Invalid token" }), { status: 401 });
    const body = JSON.parse(init.body);
    if (typeof body.text !== "string" || body.text.length === 0) return new Response("{}", { status: 400 });
    const id = String(this.comments.length + 1);
    this.comments.push({ issueId: decodeURIComponent(match[1]), text: body.text, authorization });
    return new Response(JSON.stringify({ id, data: { text: body.text }, type: "note" }), { status: 201 });
  }
}
