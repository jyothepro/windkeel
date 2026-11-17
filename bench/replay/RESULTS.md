# Replay results

Recorded output of `node dist/cli.js replay`. Re-run it and replace this file; it is a record of
one run, not a checked-in expectation.

## Run of 2026-09-22 — 3/3 gates said fail; 2/3 named the defect that surfaced

```
  axios-7257-strict-json
    upstream:  axios/axios#7257 @ 7d19335e43d6
    surfaced:  reverted in a4230f5581b3 — Revert "fix: silentJSONParsing=false should throw on invalid JSON (#7253) (#7..." (#7298)
    gate:      CAUGHT — verdict fail, reviewer anthropic/claude-sonnet-5
      - [blocking] The new regression test test/regression_silent_json.js will never run as part of the project's automated test commands.
  express-4891-sync-stack
    upstream:  expressjs/express @ 708ac4cdf5cd
    surfaced:  fixed in 7ec5dd2b3c5e — Fix regression routing a large stack in a single route
    gate:      CAUGHT — verdict fail, reviewer anthropic/claude-sonnet-5
      - [blocking] Route.prototype.dispatch's max-sync-stack guard drops a middleware/handler layer instead of merely deferring it
  undici-3284-permessage-deflate
    upstream:  nodejs/undici#3284 @ 13523fd7fe66
    surfaced:  reverted in fcfa4db68098 — revert: "websocket: pre-calculated length" (#3290)
    gate:      CAUGHT — verdict fail, reviewer anthropic/claude-sonnet-5
      - [blocking] Compressed (permessage-deflate) WebSocket messages will always be delivered to the application as empty buffers due to missing fragmentsBytes tracking in the decompression path.

caught 3/3 replayed defects (0 not evaluated, 0 error(s))
```

**What this run establishes.** With a reviewer credential set, all three cases reach an evaluated
verdict, and all three are `fail`. That is the first time this harness has asked its question at
all: the 2026-07-26 run below was 0/3 *asked*, not 0/3 caught.

**Read the catch count carefully, because it is a proxy.** `caught` means the gate returned
`fail`, not that the reviewer named the defect the revert was about. On this run:

| case | gate | finding |
|---|---|---|
| `undici-3284` | fail | **the upstream defect.** `#fragmentsBytes` never incremented in the decompression branch, so compressed messages arrive empty |
| `express-4891` | fail | **the upstream defect.** The sync-stack guard sits after `idx++`, so the fetched layer is dropped and its handler never runs — which is precisely what 4.18.0 shipped and 4.18.2 fixed |
| `axios-7257` | fail | **a different, real problem.** That the added regression test `test/regression_silent_json.js` is never run by the project's test commands. True, blocking, and not the `silentJSONParsing` behaviour the revert was about |

So the honest statement is **2/3 identified the defect that reached users, and 3/3 refused the
change.** The third refusal is not a false positive — an untested regression test is worth
blocking on — but counting it as a catch would overstate what was demonstrated.

**What had to be fixed before this run could happen, and it is the more useful finding.** The
first attempt reported two of three cases as errors: *"model returned no JSON object"*. The cause
was not the model's formatting. `claude-sonnet-5` returned `stop_reason: "max_tokens"` with
`content: [{ type: "thinking" }]` and `output_tokens: 4096`, **all of them thinking tokens** —
the reviewer spent its entire output budget reasoning and never began to write. The call was
billed in full, the answer was discarded, and the error named the model's output format.

The budget was the whole story, and it was measured rather than guessed:

| `max_tokens` | caught | truncated |
|---|---|---|
| 4096 (the old default) | 1/3 | 2 |
| 16384 | 2/3 | 1 |
| 32768 (the new default) | 3/3 | 0 |

At 16384 the express case produced nothing at all. At 32768 it named the defect exactly. A
reviewer that cannot afford to think does not return a worse answer — it returns none, and the
old code could not tell that apart from a model that cannot follow a format.

**What this run does not establish.** Three cases is three cases. It says the adversarial reviewer
prompt works against real diffs with a real model, not that it generalises — and the axios result
is a reminder that a `fail` verdict and a correct diagnosis are different things.

## Run of 2026-07-26 — harness verified, gate not yet evaluated

```
  axios-7257-strict-json
    upstream:  axios/axios#7257 @ 7d19335e43d6
    surfaced:  reverted in a4230f5581b3 — Revert "fix: silentJSONParsing=false should throw on invalid JSON (#7253) (#7..." (#7298)
    gate:      not evaluated — review stage skipped
  express-4891-sync-stack
    upstream:  expressjs/express @ 708ac4cdf5cd
    surfaced:  fixed in 7ec5dd2b3c5e — Fix regression routing a large stack in a single route
    gate:      not evaluated — review stage skipped
  undici-3284-permessage-deflate
    upstream:  nodejs/undici#3284 @ 13523fd7fe66
    surfaced:  reverted in fcfa4db68098 — revert: "websocket: pre-calculated length" (#3290)
    gate:      not evaluated — review stage skipped

0 of 3 cases evaluated — no reviewer configured, so nothing was asked of a model. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.
```

**What this run establishes.** All three upstream commit pairs fetch and rebuild: the harness
reaches the real repositories, the SHAs in `cases/` are real, and the reconstructed diff matches
the upstream diff (checked against `expressjs/express` — 5 files changed, 56 insertions, both
ways). No case errored, and the checks stage in each package is a `no_checks_discovered`
warning rather than a failure, so nothing here is a catch obtained for the wrong reason.

**What this run does not establish.** Nothing about detection. The environment had no model
credential, so the review stage recorded itself as skipped in all three packages and every case
is reported as *not evaluated*. No case reached a `fail` verdict, but that is because the gate
was asked nothing — this is not "0/3 caught", it is 0/3 asked.
