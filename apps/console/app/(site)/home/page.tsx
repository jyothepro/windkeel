import type { Metadata } from "next";
import Link from "next/link";
import { REPOSITORY_URL, inviteRequestUrl } from "../../../lib/site.ts";

export const metadata: Metadata = { title: { absolute: "Windkeel: independent verification for AI-written pull requests" } };

const ACTION_SNIPPET = `jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0, persist-credentials: false }
      - uses: jyothepro/windkeel@<pinned-sha>
        with:
          mode: verify
          anthropic-api-key: \${{ secrets.ANTHROPIC_API_KEY }}`;

const STEPS = [
  {
    title: "A maker writes the change",
    body: "Codex, Claude Code or a person implements the task in its own sandbox. Windkeel treats whatever it wrote as untrusted.",
  },
  {
    title: "A verifier checks it, somewhere else",
    body: "A fresh sandbox, a clean clone, separate credentials and a reviewer from another vendor. It runs your checks from the base commit, reviews the diff adversarially and maps every acceptance criterion to evidence.",
  },
  {
    title: "You get a verdict you can recompute",
    body: "pass, warn or fail, inside a signed evidence package: what ran, the transcripts, the findings and who wrote the code. Anyone can re-verify it offline.",
  },
];

const PACKAGE_LINES = [
  { name: "manifest.json", note: "what was checked, at which commit" },
  { name: "intent.json", note: "the task and its acceptance criteria" },
  { name: "mapping.json", note: "each criterion, and the evidence that settles it" },
  { name: "findings/", note: "review, security and browser QA findings" },
  { name: "verdict.json", note: "pass, warn or fail, recomputed from the above" },
  { name: "hashes.json + bundle", note: "Sigstore keyless signature over all of it" },
];

export default function HomePage() {
  const invite = inviteRequestUrl();
  return (
    <>
      <section className="site-hero">
        <p className="text-overline">Self-run gate · managed factory</p>
        <h1>Your coding agent should not grade its own homework.</h1>
        <p className="site-lead">
          Windkeel is an independent verifier for pull requests written by AI. It checks every change in a fresh sandbox the
          author cannot touch, and leaves behind evidence anyone can recompute.
        </p>
        <div className="site-actions">
          <a className="oq-button oq-button--primary oq-button--lg" href={invite}>
            Request an invite
          </a>
          <a className="oq-button oq-button--lg" href={REPOSITORY_URL}>
            Add the gate to your CI
          </a>
        </div>
      </section>

      <section className="site-compare" aria-label="What the agent says, and what the verifier finds">
        <div className="site-panel">
          <p className="text-overline">The agent says</p>
          <pre className="site-code">{"✓ Implemented rate limiting on /v1/tasks\n✓ Added tests\n✓ All checks pass\n\nReady to merge."}</pre>
        </div>
        <div className="site-panel">
          <p className="text-overline">Windkeel finds</p>
          <pre className="site-code">
            <span className="site-verdict site-verdict--fail">fail</span>
            {"\nAC2  limit applies per organization   unsettled\n     the new test sends one request\nREV  limiter keyed on client IP header\n     spoofable behind the proxy\n\nRepair loop: 1 turn → "}
            <span className="site-verdict site-verdict--pass">pass</span>
          </pre>
        </div>
      </section>
      <p className="site-caption">An illustration of the kind of gap the verifier catches. Real findings come from your repository and your checks.</p>

      <section className="site-section">
        <h2>How it works</h2>
        <ol className="site-steps">
          {STEPS.map((step, index) => (
            <li key={step.title} className="site-card">
              <span className="site-step-number">{index + 1}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="site-section site-two">
        <div className="site-card">
          <p className="text-overline">Run it yourself</p>
          <h3>Windkeel Gate</h3>
          <p>
            A CLI and a GitHub Action that verify any pull request, whoever or whatever wrote it. No servers: it runs in your CI on
            your keys. Free for personal and noncommercial use; commercial use needs a plan or a license.
          </p>
          <pre className="site-code site-code--small">{ACTION_SNIPPET}</pre>
          <p>
            Or locally: <code className="oq-mono">npx windkeel verify --gate</code>
          </p>
        </div>
        <div className="site-card">
          <p className="text-overline">Managed service</p>
          <h3>Windkeel factory</h3>
          <p>
            Describe work in the console, a GitHub issue, Slack, Linear, Jira or an API call. A maker agent implements it, the gate
            verifies it, and failures go back for repair. You get a verified draft pull request with its evidence attached.
          </p>
          <ul className="site-list">
            <li>Codex as the maker today, Claude Code next, on your own model keys if you want</li>
            <li>Live sessions you can take over, then hand back</li>
            <li>Spend you can see per run, with a hard stop when credits run out</li>
          </ul>
          <div className="site-actions">
            <a className="oq-button oq-button--primary" href={invite}>
              Request an invite
            </a>
            <Link className="oq-button" href="/pricing">
              See pricing
            </Link>
          </div>
        </div>
      </section>

      <section className="site-section">
        <h2>Evidence, not a green check</h2>
        <p className="site-lead">
          Every verification produces a portable package. A check that did not run is recorded as skipped with a reason, never
          silently absent. What fails your build is a recomputation from the artifact, not a verdict a step printed.
        </p>
        <ul className="site-package">
          {PACKAGE_LINES.map((line) => (
            <li key={line.name}>
              <code className="oq-mono">{line.name}</code>
              <span>{line.note}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="site-section site-cta">
        <h2>Start with the gate. Add the factory when you are ready.</h2>
        <div className="site-actions">
          <a className="oq-button oq-button--primary oq-button--lg" href={invite}>
            Request an invite
          </a>
          <Link className="oq-button oq-button--lg" href="/docs">
            Read the docs
          </Link>
        </div>
      </section>
    </>
  );
}
