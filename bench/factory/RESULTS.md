# Factory benchmark results

Recorded live runs of `windkeel bench-factory` ([README](README.md)). Each entry is one run against
one deployment, copied from its `report.json` — numbers are never edited after the fact, and a run
that went wrong is recorded as it went.

**No live run has been recorded yet.** The harness, the tasks and the offline tests landed with
[#386]; the first live run is an operator step, capped at $2 a task and $50 in all.

## Template

```markdown
## YYYY-MM-DD — <deployment> @ <deployment commit>

- Maker: <model> (<harness>), checker: <model>
- Caps: $<task> per task, $<total> per run; concurrency <n>
- Tasks: <n> (<swe-bench n>, <real-repo n>); `--check-hidden` all ok: yes/no

| metric | value | counts |
|---|---|---|
| success rate | | successes / attempted |
| verified false-accept rate | | false accepts / accepted |
| verified false-reject rate | | false rejects / rejected |
| repair conversion rate | | converted / failed first |
| cost per task (mean / p50 / p90) | | |
| cost per success | | |
| wall time per task (mean / p50 / p90) | | |
| total spent | | |

Excluded: <id: reason, …>

<details><summary>report.json</summary>

…

</details>
```

[#386]: https://github.com/jyothepro/orqon/issues/386
