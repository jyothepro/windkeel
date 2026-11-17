import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorFrame, eventFrame, frame, keepAlive, SSE_HEADERS } from "../apps/ingress/dist/src/api/sse.js";

function parse(wire) {
  return wire
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const out = {};
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) return { comment: line.slice(1).trim() };
        const at = line.indexOf(": ");
        out[line.slice(0, at)] = line.slice(at + 2);
      }
      return out;
    });
}

test("a frame carries the cursor as the SSE id, so a browser's own resume works", () => {
  const [parsed] = parse(frame("transition", { to: "VERIFYING" }, "184"));
  assert.equal(parsed.id, "184");
  assert.equal(parsed.event, "transition");
  assert.deepEqual(JSON.parse(parsed.data), { to: "VERIFYING" });
});

test("a payload with newlines cannot break the framing", () => {
  // A bare newline inside a data payload ends the frame early, and the remainder is parsed as
  // the next event's fields. JSON.stringify escapes them, which is why it is not optional.
  const wire = frame("cost", { reason: "line one\nline two" }, "9");
  assert.equal(parse(wire).length, 1);
  assert.equal(JSON.parse(parse(wire)[0].data).reason, "line one\nline two");
});

test("the closing frame says whether to reconnect, because a client cannot tell why it ended", () => {
  const cut = JSON.parse(parse(cursorFrame("184", "budget_exhausted"))[0].data);
  assert.deepEqual(cut, { cursor: "184", reason: "budget_exhausted", reconnect: true });

  const done = JSON.parse(parse(cursorFrame("200", "run_terminal"))[0].data);
  assert.equal(done.reconnect, false, "a finished run must not be reconnected to forever");
});

test("a keep-alive is a comment, so it cannot be mistaken for an event or advance a cursor", () => {
  const [parsed] = parse(keepAlive());
  assert.equal(parsed.comment, "keep-alive");
  assert.equal(parsed.id, undefined);
  assert.equal(parsed.event, undefined);
});

test("the headers defeat proxy buffering, which is what turns a stream into a slow download", () => {
  assert.match(SSE_HEADERS["content-type"], /^text\/event-stream/);
  assert.match(SSE_HEADERS["cache-control"], /no-transform/);
  assert.equal(SSE_HEADERS["x-accel-buffering"], "no");
});

test("an event frame's id is the event's own cursor", () => {
  const [parsed] = parse(eventFrame({ kind: "transition", cursor: "12", at: new Date(0), from: null, to: "CREATED", reason: null }));
  assert.equal(parsed.id, "12");
  assert.equal(parsed.event, "transition");
});
