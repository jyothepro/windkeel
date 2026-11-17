import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  TruncatedResponseError,
  modelPolicyFromEnv,
  parseJsonResponse,
  selectGateway,
} from "@windkeel/verification/providers/index.js";

/**
 * #49: a reviewer that ran out of output budget used to report as a reviewer that cannot follow
 * a format.
 *
 * `claude-sonnet-5` against the axios#7257 diff returned `stop_reason: "max_tokens"` with
 * `content: [{ type: "thinking" }]` and `output_tokens: 4096`, every one of them a thinking
 * token. The call was billed in full, the answer was discarded, and the error read "model
 * returned no JSON object" — which sends whoever reads it to the prompt, when the fix was a
 * number. Two of the three replay cases failed this way.
 *
 * So what is pinned here is the *diagnosis*, not just the failure: these two causes must never
 * again produce the same sentence.
 */

const AUTHOR = { vendor: "openai", model: "gpt-5-codex" };
const CLAUDE = { vendor: "anthropic", model: "claude-sonnet-5" };
/** ADR-0010: the checker must not be the maker, so each case names a maker it is independent of. */
const policy = (endpoints, maker = AUTHOR) => ({ endpoints, maker });

/** Stands in for the vendor for one call, and reports what the gateway asked for. */
async function withFetch(response, fn) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => response,
      text: async () => JSON.stringify(response),
    };
  };
  try {
    return { result: await fn(), seen };
  } finally {
    globalThis.fetch = original;
  }
}

test("an empty answer and a malformed one are different sentences", () => {
  // Before: both were "model returned no JSON object", and only one of them is about JSON.
  assert.throws(() => parseJsonResponse(""), /no text at all/);
  assert.throws(() => parseJsonResponse("   \n "), /no text at all/);
  assert.throws(() => parseJsonResponse("I cannot review this diff."), /no JSON object/);

  assert.deepEqual(parseJsonResponse('{"findings":[]}'), { findings: [] });
  // Prose either side of the object is still an answer — that part was always right.
  assert.deepEqual(parseJsonResponse('Here you go:\n{"ok":true}\nHope that helps.'), { ok: true });
});

test("a truncated anthropic response names the budget, not the model's formatting", async () => {
  const gateway = selectGateway(
    policy([{ vendor: "anthropic", model: "claude-sonnet-5", apiKey: "k" }]),
    AUTHOR,
    "review",
  );

  // The exact shape observed on the #49 replay: well-formed, billed, and containing no answer.
  const { result } = await withFetch(
    {
      stop_reason: "max_tokens",
      content: [{ type: "thinking" }],
      usage: { input_tokens: 12601, output_tokens: 4096 },
    },
    () => gateway.generate({ system: "s", user: "u" }).then(
      () => "resolved",
      (err) => err,
    ),
  );

  assert.ok(result instanceof TruncatedResponseError, `expected truncation, got ${result}`);
  assert.match(result.message, /entire 32768-token output budget/);
  assert.match(result.message, /WINDKEEL_MODEL_MAX_TOKENS/);
  // The old failure. If this ever reappears the diagnosis has regressed even if the throw has not.
  assert.doesNotMatch(result.message, /no JSON object/);
});

test("a truncated openai-compatible response fails the same way", async () => {
  const gateway = selectGateway(
    policy([{ vendor: "openai", model: "gpt-5", apiKey: "k" }], CLAUDE),
    CLAUDE,
    "review",
  );

  const { result } = await withFetch(
    {
      choices: [{ finish_reason: "length", message: { content: '{"findings":[' } }],
      usage: { prompt_tokens: 10, completion_tokens: 32768 },
    },
    () => gateway.generate({ system: "s", user: "u" }).then(() => "resolved", (err) => err),
  );

  // Note the content is *almost* valid JSON. Without the finish_reason check this reaches
  // JSON.parse and reports as a syntax error — a third wrong diagnosis for the same cause.
  assert.ok(result instanceof TruncatedResponseError, `expected truncation, got ${result}`);
});

test("both gateways ask for a budget, and the default is the measured one", async () => {
  assert.equal(DEFAULT_MAX_OUTPUT_TOKENS, 32_768);

  const anthropic = selectGateway(
    policy([{ vendor: "anthropic", model: "claude-sonnet-5", apiKey: "k" }]),
    AUTHOR,
    "review",
  );
  const { seen: anthropicCalls } = await withFetch(
    { stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] },
    () => anthropic.generate({ system: "s", user: "u" }),
  );
  assert.equal(anthropicCalls[0].body.max_tokens, DEFAULT_MAX_OUTPUT_TOKENS);

  const openai = selectGateway(
    policy([{ vendor: "openai", model: "gpt-5", apiKey: "k" }], CLAUDE),
    CLAUDE,
    "review",
  );
  const { seen: openaiCalls } = await withFetch(
    { choices: [{ finish_reason: "stop", message: { content: "{}" } }] },
    () => openai.generate({ system: "s", user: "u" }),
  );
  assert.equal(openaiCalls[0].body.max_completion_tokens, DEFAULT_MAX_OUTPUT_TOKENS);
});

test("a model's thinking is dropped rather than read as its answer", async () => {
  const gateway = selectGateway(
    policy([{ vendor: "anthropic", model: "claude-sonnet-5", apiKey: "k" }]),
    AUTHOR,
    "review",
  );
  const { result } = await withFetch(
    {
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "maybe {\"findings\":[{\"claim\":\"invented\"}]}" },
        { type: "text", text: '{"findings":[]}' },
      ],
    },
    () => gateway.generate({ system: "s", user: "u" }),
  );

  // Reasoning is not a finding. Concatenating it would put a model's discarded guesses into an
  // evidence package as though somebody had stood behind them.
  assert.equal(result.text, '{"findings":[]}');
  assert.doesNotMatch(result.text, /invented/);
});

test("WINDKEEL_MODEL_MAX_TOKENS overrides it, and nonsense falls back rather than failing a run", () => {
  const withEnv = (value) =>
    modelPolicyFromEnv({ ANTHROPIC_API_KEY: "k", ...(value === undefined ? {} : { WINDKEEL_MODEL_MAX_TOKENS: value }) })
      .endpoints[0].maxOutputTokens;

  assert.equal(withEnv("65536"), 65_536);
  assert.equal(withEnv(undefined), undefined, "absent means the default, not a written-in number");

  // A verification is not worth failing over a mistyped budget: every one of these falls back.
  for (const bad of ["", "lots", "-1", "0", "1.5", "1e4x"]) {
    assert.equal(withEnv(bad), undefined, `WINDKEEL_MODEL_MAX_TOKENS=${bad} should fall back`);
  }
});
