import type { Metadata } from "next";
import { CodeBlock } from "../components/code-block.tsx";
import { Faq } from "../components/faq.tsx";
import { GateTabs } from "../components/gate-tabs.tsx";
import { HeroIllustration } from "../components/hero-illustration.tsx";
import { HowItWorks } from "../components/how-it-works.tsx";
import { JsonLd } from "../components/json-ld.tsx";
import { ArrowRightIcon, CheckIcon } from "../components/icons.tsx";
import { PricingPlans } from "../components/pricing.tsx";
import { VERIFY_PACKAGE_SNIPPET } from "../components/snippets.ts";
import { VerdictBadge } from "../components/verdict.tsx";
import { site } from "../site.config.ts";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

const INTAKE = [
  { name: "Web console", detail: "Describe the task and pick the agent." },
  { name: "GitHub issue label", detail: "Label an issue to start a run." },
  { name: "Slack", detail: "Ask from the channel you're in." },
  { name: "Linear", detail: "Hand over an issue." },
  { name: "Jira", detail: "Hand over a work item." },
  { name: "Signed webhook", detail: "From any system that can POST." },
  { name: "CLI and API", detail: "From a script or your CI." },
  { name: "Cron schedules", detail: "Recurring work on a timetable." },
] as const;

const WHY = [
  {
    title: "A different vendor",
    body: "The agent that wrote the code shouldn't be the one grading it. The verifier runs a model from another vendor than the maker.",
  },
  {
    title: "A fresh sandbox",
    body: "Verification starts clean. It takes nothing from the maker except its commits: no files, dependencies or environment.",
  },
  {
    title: "Evidence anyone can recompute",
    body: "The verdict comes with what was checked and why. Anyone can recompute it offline, without asking Windkeel.",
  },
] as const;

const PACKAGE_CONTENTS = [
  "What was checked, and what each check found",
  "Transcripts of the review",
  "Each acceptance criterion mapped to its evidence",
  "Which agent and model wrote the change",
  "Checks that did not run, recorded as skipped with a reason",
  "The verdict: pass, warn or fail",
] as const;

const CLOUD_FEATURES = [
  "Intake from the console, GitHub, Slack, Linear, Jira, webhooks, the API and schedules",
  "Maker, independent verifier and repair loop, with caps on attempts, spend and time",
  "Pick the agent and model, and watch the session live",
  "Take over in a workspace of your own, then hand back",
  "Draft pull requests you merge as yourself",
] as const;

const GATE_FEATURES = [
  "Verifies any pull request, whoever or whatever wrote it",
  "Writes the same evidence package",
  "Runs in your own CI with your own model keys",
  "No servers",
] as const;

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <CheckIcon className="mt-1 flex-none text-accent-ink" />
      <span>{children}</span>
    </li>
  );
}

export default function HomePage() {
  return (
    <>
      <JsonLd />
      <section aria-labelledby="hero-title" className="relative overflow-hidden">
        <div className="wind pointer-events-none absolute inset-x-0 bottom-0 h-32" aria-hidden="true" />
        <div className="container-page relative grid items-center gap-14 pb-20 pt-14 md:pt-20 lg:grid-cols-[1.05fr_1fr] lg:gap-16 [&>*]:min-w-0 lg:pb-28 lg:pt-24">
          <div>
            <p className="eyebrow">Independent verification for coding agents</p>
            <h1
              id="hero-title"
              className="mt-4 text-[clamp(2.375rem,1.5rem+3.6vw,3.75rem)] font-semibold leading-[1.04] tracking-[-0.035em] text-balance"
            >
              Agents write the code. Windkeel proves it.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted text-pretty">
              Describe a piece of engineering work and get back a verified draft pull request. A maker agent writes the
              change; an independent verifier, from a different vendor and in a fresh sandbox, decides whether it
              passes.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a href="/request-access" className="btn btn-primary">
                Request access
                <ArrowRightIcon />
              </a>
              <a href="#gate-cloud" className="btn btn-secondary">
                Try the Gate free
              </a>
            </div>
            <p className="mt-4 text-sm text-muted">Sign-up is invite-only for now.</p>
          </div>
          <HeroIllustration />
        </div>
      </section>

      <section id="how-it-works" aria-labelledby="how-title" className="section">
        <div className="container-page">
          <p className="eyebrow">How it works</p>
          <h2 id="how-title" className="section-title mt-3">
            The maker is the wind. The verifier is the keel.
          </h2>
          <p className="section-lead">
            Wind drives a boat forward; the keel keeps it on course. In Windkeel, a maker agent moves the work, and a
            verifier it doesn&apos;t control decides whether the result holds.
          </p>
          <HowItWorks />
        </div>
      </section>

      <section id="why" aria-labelledby="why-title" className="section">
        <div className="container-page">
          <p className="eyebrow">Why an independent verifier</p>
          <h2 id="why-title" className="section-title mt-3">
            The author shouldn&apos;t grade its own work.
          </h2>
          <ul className="mt-12 grid gap-4 md:grid-cols-3">
            {WHY.map((point, index) => (
              <li key={point.title} className="card p-6">
                <p className="font-mono text-xs text-muted">0{index + 1}</p>
                <h3 className="mt-3 text-lg font-semibold">{point.title}</h3>
                <p className="mt-2 leading-relaxed text-muted">{point.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section id="evidence" aria-labelledby="evidence-title" className="section">
        <div className="container-page grid gap-12 lg:grid-cols-2 lg:gap-16 [&>*]:min-w-0">
          <div>
            <p className="eyebrow">The evidence package</p>
            <h2 id="evidence-title" className="section-title mt-3">
              A verdict you can check without us.
            </h2>
            <p className="section-lead">
              Every run ends with an evidence package. It can be sealed with Sigstore, so{" "}
              <code className="rounded bg-sunken px-1.5 py-0.5 text-[0.9em] text-fg">cosign verify-blob</code> alone can
              check it. You don&apos;t need Windkeel to check Windkeel&apos;s output.
            </p>
            <div className="mt-8">
              <p className="text-sm font-medium">Three verdicts, never softened</p>
              <dl className="mt-3 grid gap-3">
                <div className="flex items-start gap-3">
                  <dt className="w-16 flex-none">
                    <VerdictBadge verdict="pass" />
                  </dt>
                  <dd className="text-sm text-muted">The change meets its criteria and passed every check that ran.</dd>
                </div>
                <div className="flex items-start gap-3">
                  <dt className="w-16 flex-none">
                    <VerdictBadge verdict="warn" />
                  </dt>
                  <dd className="text-sm text-muted">Something needs a person&apos;s judgment before merging.</dd>
                </div>
                <div className="flex items-start gap-3">
                  <dt className="w-16 flex-none">
                    <VerdictBadge verdict="fail" />
                  </dt>
                  <dd className="text-sm text-muted">The change does not meet its criteria or a check failed.</dd>
                </div>
              </dl>
            </div>
          </div>
          <div className="card p-6 md:p-8">
            <h3 className="text-base font-semibold">What&apos;s inside</h3>
            <ul className="mt-4 grid gap-3 text-[0.9375rem]">
              {PACKAGE_CONTENTS.map((item) => (
                <Bullet key={item}>{item}</Bullet>
              ))}
            </ul>
            <h3 className="mt-8 text-base font-semibold">Re-check it offline</h3>
            <div className="mt-3">
              <CodeBlock
                code={VERIFY_PACKAGE_SNIPPET}
                label="Command to re-check an evidence package"
                copyLabel="Copy the verify-package command"
              />
            </div>
          </div>
        </div>
      </section>

      <section id="intake" aria-labelledby="intake-title" className="section">
        <div className="container-page">
          <p className="eyebrow">Start work from anywhere</p>
          <h2 id="intake-title" className="section-title mt-3">
            Work arrives where your team already is.
          </h2>
          <p className="section-lead">Every door ends in the same task: a title, a description and acceptance criteria.</p>
          <ul className="mt-12 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
            {INTAKE.map((source) => (
              <li key={source.name} className="bg-surface p-5">
                <h3 className="text-[0.9375rem] font-semibold">{source.name}</h3>
                <p className="mt-1 text-sm text-muted">{source.detail}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section id="gate-cloud" aria-labelledby="gate-title" className="section">
        <div className="container-page">
          <p className="eyebrow">Two ways to use it</p>
          <h2 id="gate-title" className="section-title mt-3">
            Start with the gate. Add the factory when you want it.
          </h2>
          <div className="mt-12 grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
            <article className="card flex flex-col p-6 md:p-8" aria-labelledby="gate-card-title">
              <p className="font-mono text-xs text-muted">Source-available · free for noncommercial use</p>
              <h3 id="gate-card-title" className="mt-2 text-2xl font-semibold tracking-tight">
                Windkeel Gate
              </h3>
              <p className="mt-2 text-muted">A CLI and GitHub Action that verifies pull requests in your own CI.</p>
              <ul className="mt-6 grid gap-2.5 text-[0.9375rem]">
                {GATE_FEATURES.map((item) => (
                  <Bullet key={item}>{item}</Bullet>
                ))}
              </ul>
              <div className="mt-8">
                <GateTabs />
              </div>
            </article>
            <article className="card flex flex-col p-6 md:p-8" aria-labelledby="cloud-card-title">
              <p className="font-mono text-xs text-muted">Managed</p>
              <h3 id="cloud-card-title" className="mt-2 text-2xl font-semibold tracking-tight">
                Windkeel Cloud
              </h3>
              <p className="mt-2 text-muted">
                The full factory: intake, maker, verifier, repair loop, draft pull requests and a console.
              </p>
              <ul className="mt-6 grid gap-2.5 text-[0.9375rem]">
                {CLOUD_FEATURES.map((item) => (
                  <Bullet key={item}>{item}</Bullet>
                ))}
              </ul>
              <div className="mt-auto pt-8">
                <a href="/request-access" className="btn btn-primary">
                  Request access to Cloud
                </a>
              </div>
            </article>
          </div>
        </div>
      </section>

      <section id="pricing" aria-labelledby="pricing-title" className="section">
        <div className="container-page">
          <p className="eyebrow">Pricing for Cloud</p>
          <h2 id="pricing-title" className="section-title mt-3">
            Pay for compute. AI at cost.
          </h2>
          <p className="section-lead">
            One credit is US$0.01. A sandbox-minute costs 2 credits, for the maker and the verifier alike. Verification
            is metered like everything else and never skipped to save money.
          </p>
          <div className="mt-10">
            <PricingPlans />
          </div>
          <div className="mt-8 grid gap-4 text-sm text-muted md:grid-cols-3">
            <p>
              <span className="font-medium text-fg">Plan credits</span> reset every month.
            </p>
            <p>
              <span className="font-medium text-fg">Top-ups</span>, valid for 12 months: $10 for 1,000, $25 for 2,500,
              $50 for 5,000 credits.
            </p>
            <p>
              <span className="font-medium text-fg">Overage</span> is off unless an admin turns it on, with a monthly
              cap.
            </p>
          </div>
        </div>
      </section>

      <section id="faq" aria-labelledby="faq-title" className="section">
        <div className="container-page grid gap-10 lg:grid-cols-[1fr_2fr] lg:gap-16 [&>*]:min-w-0">
          <div>
            <p className="eyebrow">FAQ</p>
            <h2 id="faq-title" className="section-title mt-3">
              Questions
            </h2>
          </div>
          <Faq />
        </div>
      </section>

      <section aria-labelledby="cta-title" className="section">
        <div className="container-page">
          <div className="relative overflow-hidden rounded-2xl bg-inverse px-6 py-14 text-on-inverse md:px-12 md:py-16">
            <h2 id="cta-title" className="max-w-2xl text-[clamp(1.75rem,1.2rem+2vw,2.5rem)] font-semibold leading-tight tracking-tight">
              Merge agent pull requests on evidence, not on faith.
            </h2>
            <p className="mt-4 max-w-xl opacity-80">Windkeel Cloud is invite-only for now. Gate is free for noncommercial use today.</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a href="/request-access" className="btn btn-primary">
                Request access
              </a>
              <a href={site.appUrl} className="btn border-current/40 text-on-inverse hover:bg-on-inverse/10">
                Sign in
              </a>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
