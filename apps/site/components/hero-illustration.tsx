import { VerdictBadge, type Verdict } from "./verdict.tsx";

const CRITERIA: { text: string; verdict: Verdict }[] = [
  { text: "Failed deliveries retry up to 5 times", verdict: "pass" },
  { text: "Delay doubles between attempts", verdict: "pass" },
  { text: "A final failure is recorded, not dropped", verdict: "pass" },
];

const CHECKS: { name: string; detail: string; verdict: Verdict }[] = [
  { name: "Repository checks", detail: "npm test, lint, typecheck", verdict: "pass" },
  { name: "Adversarial review", detail: "0 blocking findings", verdict: "pass" },
  { name: "Security scan", detail: "no new issues", verdict: "pass" },
  { name: "Browser flow", detail: "no UI change in this task", verdict: "skipped" },
];

export function HeroIllustration() {
  return (
    <figure className="relative m-0" aria-labelledby="hero-figure-caption">
      <div className="card overflow-hidden shadow-[0_24px_60px_-28px_rgb(15_17_23/0.35)]">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-4">
          <span className="rounded-full border border-line-strong px-2 py-0.5 text-xs font-medium text-muted">Draft</span>
          <p className="text-[0.9375rem] font-semibold">Retry webhook deliveries with backoff</p>
        </div>

        <div className="grid gap-5 px-5 py-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs text-muted">Verdict</p>
              <p className="mt-1 flex items-center gap-2 text-sm font-medium">
                <VerdictBadge verdict="pass" /> on attempt 2 of 3
              </p>
            </div>
            <p className="rounded-lg border border-line bg-sunken px-3 py-2 text-xs leading-relaxed text-muted">
              <span className="block">
                Maker <span className="font-medium text-fg">Codex</span>
              </span>
              <span className="block">
                Verifier <span className="font-medium text-fg">a different vendor</span>
              </span>
            </p>
          </div>

          <section aria-label="Acceptance criteria">
            <p className="text-xs font-medium text-muted">Acceptance criteria</p>
            <ul className="mt-2 grid gap-1.5">
              {CRITERIA.map((criterion) => (
                <li key={criterion.text} className="flex items-start justify-between gap-3 text-sm">
                  <span>{criterion.text}</span>
                  <VerdictBadge verdict={criterion.verdict} />
                </li>
              ))}
            </ul>
          </section>

          <section aria-label="Checks">
            <p className="text-xs font-medium text-muted">Checks, in a fresh sandbox</p>
            <ul className="mt-2 grid gap-1.5">
              {CHECKS.map((check) => (
                <li key={check.name} className="flex items-start justify-between gap-3 text-sm">
                  <span>
                    {check.name} <span className="text-muted">· {check.detail}</span>
                  </span>
                  <VerdictBadge verdict={check.verdict} />
                </li>
              ))}
            </ul>
          </section>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-sunken px-3 py-2 font-mono text-xs text-muted">
            <span>evidence package</span>
            <span>sealed with Sigstore</span>
          </div>
        </div>
      </div>
      <figcaption id="hero-figure-caption" className="mt-3 text-center text-xs text-muted">
        Illustration of a draft pull request and its verdict. Not a real run.
      </figcaption>
    </figure>
  );
}
