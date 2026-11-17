# windkeel M1 CLI — test report (PR #25, `devin/1785043768-windkeel-gate-m1`)

Shell-only testing (CLI, no GUI/recording). Commit under test: `159b32d`. Built with `npm run build`.

## Summary

Executed the full adversarial plan. Core contracts (exit codes, verdict purity, tamper detection,
criteria extraction, provenance) behave as specified, with **two defects** and two notes.

### 🔴 Defect 1 (high): check output > 1 MB → false blocking finding + silently truncated transcript

`spawnSync` is called without `maxBuffer`, so Node's 1 MB default applies. A check that prints more
than 1 MB is killed, `result.status` is `null`, and `exitCode = result.status ?? 1` records **exit 1**,
producing a blocking finding and a `fail` verdict for a check that actually succeeded. The stored
transcript is truncated to ~1 MB with no marker. Real `npm test`/`lint` output on a mid-size repo
easily crosses 1 MB, so this can hard-fail the gate (`--gate` → exit 1) on green repos.

```
$ cat '/tmp/weird repo/windkeel.config.json'
{"checks":[{"name":"huge","command":"node -e \"process.stdout.write('x'.repeat(5*1024*1024))\""}, ...]}

$ node dist/cli.js verify --repo '/tmp/weird repo' --out '/tmp/weird out'
verdict: FAIL          # expected PASS — the command exits 0

$ python3 -c "import json;d=json.load(open('/tmp/weird out/evidence/ev-01.json'));print(d['status'],d['producer']['exit_code'])"
failed 1               # real exit code is 0
$ ls -l '/tmp/weird out/evidence/ev-01-huge.log'
-rw-r--r-- 1114170     # 5 MB of output silently truncated to ~1 MB
```

Control at 500 KB → `passed`, `exit_code 0`, verdict PASS. Suggested fix: pass
`maxBuffer: Infinity` (or a large cap plus an explicit truncation marker) and distinguish
`result.error` / `result.signal` from a genuine non-zero exit.

### 🟠 Defect 2 (minor, spec mismatch): missing/empty package dir exits 3, spec says 2

```
$ node dist/cli.js verify-package /tmp/does-not-exist ; echo $?
windkeel: ENOENT: no such file or directory, open '/tmp/does-not-exist/manifest.json'
3        # spec: usage error → 2
```
Error output is clean (no stack trace), so this is only a code-classification issue. Same for an
empty dir and for malformed JSON (`windkeel: Expected property name or '}' in JSON at position 2`, exit 3
— arguably correct as an integrity failure).

### Note A: `seal` re-legitimises a fully rewritten package
Because local runs are unsigned (`keyid: unsigned-local`), rewriting evidence JSON **and**
verdict.json consistently and then running `seal` yields `integrity: ok | verdict: PASS` (exit 0)
even though the retained transcript `ev-01.log` still shows `exit 7`. This is expected for M1
(signing is future work) but means local packages carry no attacker resistance; the transcript is
never cross-checked against the evidence JSON.

### Note B: repo with no package.json and no config → vacuous PASS
`verify` on an empty directory yields `verdict: pass`, `evidence_counts {skipped: 3}`,
summary "All 0 repo checks passed". Zero checks currently gate green.

## Results

| # | Assertion | Result |
|---|---|---|
| T0.1 | `npm run typecheck` exit 0 | passed |
| T0.2 | `npm test` → 14/14 pass, exit 0 | passed |
| T0.3 | Dogfood `verify --repo . --out /tmp/self` → `verdict: PASS`, exit 0; `verify-package /tmp/self` → `integrity: ok`, exit 0 | passed |
| T1.1 | no args / `bogus` / `verify-package` w/o dir / `seal` w/o dir → exit 2 | passed |
| T1.2 | `help` → exit 0 | passed |
| T1.3 | missing / empty package dir → exit 2 | **failed** (exit 3, Defect 2) |
| T1.4 | malformed package dir → clean error, no stack trace | passed (exit 3) |
| T2.1 | failing repo check (`exit 7`) → ev-01 `failed`, blocking `F-tests`, `verdict: fail` | passed |
| T2.2 | `verify --gate` on fail → exit 1; without `--gate` → exit 0 | passed |
| T2.3 | `verify-package --gate` on fail package → exit 1; without → exit 0 | passed |
| T3.1 | edit evidence JSON → exit 3 `hash mismatch: evidence/ev-01.json` | passed |
| T3.2 | hand-set verdict.json to pass, then `seal` → exit 3 `stored verdict "pass" != recomputed "fail"` | passed |
| T3.3 | add unhashed file → exit 3 `unhashed file present: evidence/extra.txt` | passed |
| T3.4 | delete transcript → exit 3 `missing file` + `missing transcript` | passed |
| T3.5 | delete `attestation/statement.json` → exit 3 clean ENOENT error | passed |
| T3.6 | corrupt DSSE payload → exit 3 `DSSE payload != statement.json` | passed |
| T3.7 | truncate hashes.json → exit 3 `Unexpected end of JSON input` | passed |
| T3.8 | edit hashes.json entry without reseal → exit 3 `hash mismatch` + `attestation subject digest != sha256(hashes.json)` | passed |
| T3.9 | mapping references unknown evidence id → exit 3 | passed |
| T3.10 | full consistent rewrite + `seal` → passes (unsigned by design) | see Note A |
| T4 | criteria: 2 checklist + 2 AC-section bullets from PR body, 2 from issue "Definition of done"; non-AC bullets excluded; AC1..AC6; sources `pr_description` then `linked_issue`; emoji/accents verbatim | passed |
| T5.1 | `GITHUB_EVENT_PATH` → subject.pr 25, repo `github.com/jyothepro/windkeel`, head/base sha from payload, PR body used for criteria | passed |
| T5.2 | `devin-ai-integration[bot]` → `kind agent, agent devin`; unknown `[bot]`+type Bot → `agent`, agent=login; `alice`/User → `human` | passed |
| T6.1 | zero-check repo → PASS (vacuous) | passed with Note B |
| T6.2 | emoji/non-ASCII transcript preserved byte-exact (`✅ héllo 日本語`) | passed |
| T6.3 | 5 s `sleep` check completes (no timeout support; run took 5.07 s) | passed |
| T6.4 | paths with spaces (`/tmp/weird repo`, `/tmp/weird out`) work | passed |
| T6.5 | relative `--repo`/`--out` resolve correctly, package verifies | passed |
| T6.6 | re-running `verify` into same `--out` removes stale files (`STALE.txt` gone), package still `integrity: ok` | passed |
| T6.7 | verdict purity: unsatisfied criterion → `fail`; warning-status evidence → `warn` (exit 0 with `--gate`) | passed |

## Selected raw evidence

```
$ node dist/cli.js verify --repo /tmp/failrepo --out /tmp/failpkg --gate ; echo $?
verdict: FAIL
package: /tmp/failpkg
1
$ cat /tmp/failpkg/verdict.json
{ "verdict": "fail", "blocking_findings": ["F-tests"], "evidence_counts": {"failed":1,"skipped":3},
  "summary": "1 blocking finding(s): F-tests" }
```

```
Tamper matrix (each on a fresh copy of a clean package):
--- edit evidence json            EXIT=3  ! hash mismatch: evidence/ev-01.json
--- handset verdict + reseal      EXIT=3  ! stored verdict "pass" != recomputed "fail"
--- extra unhashed file           EXIT=3  ! unhashed file present: evidence/extra.txt
--- delete transcript             EXIT=3  ! missing file / ! missing transcript
--- delete attestation statement  EXIT=3  windkeel: ENOENT .../attestation/statement.json
--- corrupt dsse payload          EXIT=3  ! DSSE payload != statement.json
--- truncate hashes.json          EXIT=3  windkeel: Unexpected end of JSON input
--- modify hashes entry no reseal EXIT=3  ! hash mismatch + ! attestation subject digest mismatch
--- mapping -> unknown evidence   EXIT=3  ! mapping AC1 references unknown evidence ev-99
```
