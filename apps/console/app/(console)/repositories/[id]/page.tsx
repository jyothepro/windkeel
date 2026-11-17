import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Banner } from "../../../../components/banner.tsx";
import { RunList } from "../../../../components/run-list.tsx";
import { currentOrganization, getIdentity, getRepositoryEnvironment, listAllRepositories, listRepositorySecrets, listRuns } from "../../../../lib/api.ts";
import { time } from "../../../../lib/format.ts";
import { environmentHeadline, sizeLabel, statusLabel, suggestedPatch } from "../../../../lib/environment.ts";
import { SimpleForm } from "../../../../components/simple-form.tsx";
import { invalidateEnvironment, rebuildEnvironment } from "./actions.ts";
import { RepositoryModels } from "../../../(settings)/settings/model-sections.tsx";
import { RepositoryKnowledge } from "../../../(settings)/settings/knowledge-sections.tsx";

export const metadata: Metadata = { title: "Repository" };

export default async function RepositoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [repos, runs, secrets, identity, environment] = await Promise.all([
    listAllRepositories(),
    listRuns({ repository: id }),
    listRepositorySecrets(id),
    getIdentity(),
    getRepositoryEnvironment(id),
  ]);
  const patch = environment ? suggestedPatch(environment) : null;
  const org = await currentOrganization(identity);
  const repo = repos.items.find((r) => r.id === id);
  if (!repo || !secrets) notFound();

  return (
    <main className="console-main console-main--wide">
      <header className="console-header">
        <div>
          <h1 className="oq-mono">{repo.fullName}</h1>
          <div className="console-header__sub">
            default branch <span className="oq-mono">{repo.defaultBranch ?? "—"}</span> · {repo.openRuns} open runs
          </div>
        </div>
        <a className="oq-button" href={`/tasks?repository=${repo.id}`}>
          Tasks
        </a>
      </header>

      <section className="console-section">
        <h3>Runs</h3>
        {runs.items.length ? <RunList runs={runs.items} repositories={repos.items} /> : <p className="oq-muted">No runs yet.</p>}
      </section>

      {org ? <RepositoryKnowledge org={org} repositoryId={repo.id} /> : null}

      {org ? <RepositoryModels org={org} repositoryId={repo.id} repositoryName={repo.fullName} /> : null}

      <section className="console-section">
        <h3>Secrets</h3>
        <p className="oq-muted" style={{ margin: 0 }}>
          Credentials for the dependency install — a private registry token, say. They reach only the install command, in the maker's
          and the verifier's sandbox. A value can't be read back, by anyone. Set or remove one with{" "}
          <code>windkeel secret set {repo.id} NAME @file</code>.
        </p>
        {secrets.items.length ? (
          <ul className="console-list">
            {secrets.items.map((s) => (
              <li key={s.key} className="console-list__static">
                <span className="console-list__main">
                  <span className="console-list__title oq-mono">{s.key}</span>
                  <span className="console-list__next">{s.note ?? "No note"}</span>
                </span>
                <span className="console-list__meta">
                  <span>{s.setBy}</span>
                  <span>{time(s.updatedAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Banner title="No secrets">
            <p>Most repositories need none. Add one only if dependencies install from a private registry.</p>
          </Banner>
        )}
      </section>

      {environment ? (
        <section className="console-section" aria-labelledby="environment-heading" data-testid="environment">
          <h3 id="environment-heading">Environment</h3>
          <p className="oq-muted" style={{ margin: 0 }}>
            {environmentHeadline(environment)} A snapshot is built once on the default branch — dependencies plus the{" "}
            <code>setup</code> in <code>windkeel.config.json</code>, with this repository&apos;s secrets — scanned for those secrets, and restored
            by maker and verifier sandboxes. The verifier still runs every check fresh.
          </p>
          {environment.items.length ? (
            <ul className="console-list">
              {environment.items.map((s) => (
                <li key={s.id} className="console-list__static" data-status={s.status}>
                  <span className="console-list__main">
                    <span className="console-list__title">
                      {statusLabel(s.status)} <span className="oq-mono">{s.baseSha.slice(0, 7)}</span>
                    </span>
                    <span className="console-list__next">{s.detail ?? "—"}</span>
                  </span>
                  <span className="console-list__meta">
                    <span className="oq-mono">{s.cacheKey.slice(0, 12)}</span>
                    <span>{sizeLabel(s.sizeBytes)}</span>
                    <span>{time(s.readyAt ?? s.createdAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="console-actions">
            <SimpleForm action={rebuildEnvironment} submitLabel="Rebuild">
              <input type="hidden" name="repositoryId" value={repo.id} />
            </SimpleForm>
            <SimpleForm action={invalidateEnvironment} submitLabel="Invalidate">
              <input type="hidden" name="repositoryId" value={repo.id} />
            </SimpleForm>
          </div>
          {patch ? (
            <div data-testid="suggested-setup">
              <h4>Suggested setup</h4>
              <p className="oq-muted" style={{ margin: 0 }}>
                A draft from the repository&apos;s files. Nothing here has run. Review it, then commit it to <code>windkeel.config.json</code> on the
                default branch.
              </p>
              <pre className="oq-mono">{patch}</pre>
              <ul>
                {environment.proposedSetup!.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
