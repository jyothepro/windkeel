export type Verdict = "pass" | "warn" | "fail" | "skipped";

const STYLE: Record<Verdict, string> = {
  pass: "border-pass-edge bg-pass-soft text-pass",
  warn: "border-line-strong bg-warn-soft text-warn",
  fail: "border-fail-edge bg-fail-soft text-fail",
  skipped: "border-line-strong bg-sunken text-muted",
};

function Mark({ verdict }: { verdict: Verdict }) {
  switch (verdict) {
    case "pass":
      return <span aria-hidden="true" className="size-2 rounded-full bg-current" />;
    case "fail":
      return <span aria-hidden="true" className="size-2 rounded-[2px] bg-current" />;
    case "warn":
      return <span aria-hidden="true" className="size-0 border-x-4 border-b-[7px] border-x-transparent border-b-current" />;
    case "skipped":
      return <span aria-hidden="true" className="size-2 rounded-full border border-current" />;
  }
}

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-xs font-medium ${STYLE[verdict]}`}
    >
      <Mark verdict={verdict} />
      {verdict}
    </span>
  );
}
