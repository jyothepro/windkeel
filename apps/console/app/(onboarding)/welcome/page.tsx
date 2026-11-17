import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Banner } from "../../../components/banner.tsx";
import { ActionButton } from "../../../components/model-controls.tsx";
import { SimpleForm } from "../../../components/simple-form.tsx";
import { currentOrganization, listAllRepositories, welcomeState } from "../../../lib/api.ts";
import { selfServeSignupOn } from "../../../lib/redirects.ts";
import { installOutcome } from "../../../lib/welcome.ts";
import { createOrganization, startFirstTask, startInstall } from "./actions.ts";

export const metadata: Metadata = { title: "Welcome" };

type Props = { searchParams?: Promise<{ step?: string; installed?: string; install_error?: string }> };

const muted = { margin: 0 } as const;

export default async function WelcomePage({ searchParams }: Props) {
  if (!selfServeSignupOn()) redirect("/");
  const search = (await searchParams) ?? {};
  const state = await welcomeState();

  if (state.kind === "new") {
    return (
      <div className="auth-card" data-step="organization">
        <p className="console-meta">Step 1 of 5</p>
        <h1>Create your organization</h1>
        <p>
          Windkeel is invite-only for now. Enter the code you were sent, name your organization, and choose how you&rsquo;ll pay for models. You can bring
          your own model keys later in Settings → Models.
        </p>
        <SimpleForm action={createOrganization} submitLabel="Create organization">
          <div className="oq-field">
            <label className="oq-field__label" htmlFor="welcome-invite">
              Invite code
            </label>
            <input id="welcome-invite" name="inviteCode" className="oq-input oq-input--mono" autoComplete="off" required />
          </div>
          <div className="oq-field">
            <label className="oq-field__label" htmlFor="welcome-name">
              Organization name
            </label>
            <input id="welcome-name" name="organizationName" className="oq-input" required minLength={2} maxLength={64} />
          </div>
          <fieldset className="oq-field">
            <legend className="oq-field__label">Plan</legend>
            <label className="oq-row">
              <input type="radio" name="plan" value="managed" defaultChecked /> Managed — Windkeel supplies the models; you pay AI cost and the compute fee
            </label>
            <label className="oq-row">
              <input type="radio" name="plan" value="byok" /> Bring your own keys — you pay your model provider, and Windkeel the compute fee (plus AI cost for any role you leave on Windkeel's models)
            </label>
          </fieldset>
        </SimpleForm>
      </div>
    );
  }

  const org = await currentOrganization(state.identity);
  const canGrant = org?.permissions.includes("repositories.manage") ?? false;
  const canFile = org?.permissions.includes("runs.write") ?? false;
  const repositories = (await listAllRepositories()).items;
  const outcome = installOutcome(search);

  return (
    <div className="oq-stack" style={{ ["--gap" as string]: "var(--space-5)" }}>
      <header>
        <h1>Welcome to {org?.name ?? "Windkeel"}</h1>
        <p className="oq-muted" style={muted}>
          Three steps to your first verified pull request. Every task — this one included — is checked by an independent verifier in a fresh sandbox
          before Windkeel opens anything.
        </p>
      </header>
      {outcome ? (
        <Banner intent={outcome.intent} title={outcome.intent === "success" ? "Installed" : "Not linked"}>
          <p>{outcome.text}</p>
        </Banner>
      ) : null}

      <section className="console-section" data-step="install" aria-labelledby="welcome-install">
        <p className="console-meta">Step 2 of 5</p>
        <h2 id="welcome-install">Install the GitHub App</h2>
        <p style={muted}>
          Install Windkeel&rsquo;s GitHub App on the repositories you want it to work on. GitHub asks you to authorize it, which is how Windkeel knows the
          installation is yours.
        </p>
        {canGrant && org ? (
          <div className="console-actions">
            <ActionButton label={repositories.length ? "Install on more repositories" : "Install the GitHub App"} run={startInstall.bind(null, org.id)} />
          </div>
        ) : (
          <p className="oq-muted" style={muted}>
            An admin of {org?.name ?? "your organization"} installs the App.
          </p>
        )}
      </section>

      <section className="console-section" data-step="task" aria-labelledby="welcome-task">
        <p className="console-meta">Steps 3 and 4 of 5</p>
        <h2 id="welcome-task">Pick a repository and describe a first task</h2>
        {repositories.length === 0 ? (
          <p className="oq-muted" style={muted} data-empty="repositories">
            No repositories yet — install the App first, and the ones you choose appear here.
          </p>
        ) : canFile ? (
          <SimpleForm action={startFirstTask} submitLabel="Start the run">
            <div className="oq-field">
              <label className="oq-field__label" htmlFor="welcome-repository">
                Repository
              </label>
              <select id="welcome-repository" name="repositoryId" className="oq-input" defaultValue={repositories[0]!.id}>
                {repositories.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.fullName}
                  </option>
                ))}
              </select>
            </div>
            <div className="oq-field">
              <label className="oq-field__label" htmlFor="welcome-title">
                Title
              </label>
              <input id="welcome-title" name="title" className="oq-input" placeholder="Fix the off-by-one in pagination" required />
            </div>
            <div className="oq-field">
              <label className="oq-field__label" htmlFor="welcome-description">
                What done looks like
              </label>
              <textarea
                id="welcome-description"
                name="description"
                className="oq-input"
                rows={6}
                required
                placeholder={"The last page shows the last item.\n\n- [ ] a list of 11 items with page size 10 has 2 pages\n- [ ] page 2 shows item 11"}
              />
              <p className="oq-field__hint">
                A checklist becomes the acceptance criteria the verifier judges against. Without one, Windkeel proposes criteria and waits for your approval.
              </p>
            </div>
          </SimpleForm>
        ) : (
          <p className="oq-muted" style={muted}>
            You can&rsquo;t file tasks in {org?.name ?? "this organization"}.
          </p>
        )}
      </section>

      <section className="console-section" data-step="verdict" aria-labelledby="welcome-verdict">
        <p className="console-meta">Step 5 of 5</p>
        <h2 id="welcome-verdict">Watch it to a verdict</h2>
        <p style={muted}>
          The run page shows the agent working, then the verifier&rsquo;s evidence: the repository&rsquo;s own checks, a review by a model independent
          of the one that wrote the change, and each acceptance criterion mapped to what proves it. A pass opens a pull request; a fail goes back for
          repair with the evidence. Your budget and usage are under Settings → Billing.
        </p>
        <p className="console-actions">
          <a className="oq-button oq-button--ghost oq-button--sm" href="/docs/verification">
            How verification works
          </a>
          <a className="oq-button oq-button--ghost oq-button--sm" href="/docs/billing">
            Budgets and billing
          </a>
          <a className="oq-button oq-button--ghost oq-button--sm" href="/docs/getting-started">
            Getting started
          </a>
        </p>
      </section>
    </div>
  );
}
