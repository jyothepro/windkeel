import { RepeatIcon } from "./icons.tsx";

const STEPS = [
  {
    n: 1,
    title: "Task",
    body: "A title, a description and acceptance criteria, against one repository.",
    zone: "intake",
  },
  {
    n: 2,
    title: "Maker",
    body: "Codex, Claude Code or OpenCode, with the model you choose, implements it.",
    zone: "maker",
  },
  {
    n: 3,
    title: "Verifier",
    body: "A different vendor re-runs your checks, reviews adversarially, maps each criterion to evidence, scans for security issues and can drive the app in a browser.",
    zone: "verifier",
  },
  {
    n: 4,
    title: "Repair",
    body: "On a fail, the maker gets the findings and repairs, within caps on attempts, spend and time.",
    zone: "maker",
  },
  {
    n: 5,
    title: "Draft PR",
    body: "A draft pull request with an evidence package. A person reviews and merges as themselves.",
    zone: "output",
  },
] as const;

const ZONE_LABEL: Record<(typeof STEPS)[number]["zone"], string> = {
  intake: "Intake",
  maker: "Maker sandbox",
  verifier: "Verifier sandbox, fresh",
  output: "Your repository",
};

const ZONE_STYLE: Record<(typeof STEPS)[number]["zone"], string> = {
  intake: "border-line",
  maker: "border-line-strong",
  verifier: "border-accent-edge bg-accent-soft/40",
  output: "border-line",
};

export function HowItWorks() {
  return (
    <div className="mt-12">
      <ol className="grid gap-3 lg:grid-cols-5">
        {STEPS.map((step) => (
          <li key={step.n} className={`relative flex flex-col rounded-xl border bg-surface p-5 ${ZONE_STYLE[step.zone]}`}>
            <p className="font-mono text-xs text-muted">{ZONE_LABEL[step.zone]}</p>
            <h3 className="mt-3 flex items-center gap-2 text-base font-semibold">
              <span className="inline-flex size-6 items-center justify-center rounded-full bg-inverse font-mono text-xs text-on-inverse">
                {step.n}
              </span>
              {step.title}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">{step.body}</p>
          </li>
        ))}
      </ol>
      <p className="mt-4 flex items-center gap-2 text-sm text-muted">
        <RepeatIcon className="text-accent-ink" />
        Steps 3 and 4 repeat until the verifier passes the change or a cap is reached. Each check starts from a clean
        sandbox and takes nothing from the maker except its commits.
      </p>
    </div>
  );
}
