import { Banner } from "../../../components/banner.tsx";
import { Toggle } from "../../../components/automation-controls.tsx";
import { ActionButton } from "../../../components/model-controls.tsx";
import { getMerging } from "../../../lib/api.ts";
import { time } from "../../../lib/format.ts";
import { START_PATH, outcomeMessage } from "../../../lib/github-authorization.ts";
import { PERMISSION_LABEL } from "../../../lib/permissions.ts";
import type { OrganizationView } from "../../../lib/types.ts";
import { disconnectGithubAuthorization, setAllowMerging } from "./actions.ts";

const muted = { margin: 0 } as const;

export async function Merging({ org, outcome }: { org: OrganizationView; outcome?: string | undefined }) {
  const settings = await getMerging(org.id);
  const said = outcomeMessage(outcome);
  if (!settings) {
    return (
      <section className="console-section">
        <p className="oq-muted" style={muted}>
          Merging from Windkeel isn&rsquo;t on for this deployment. An operator turns it on with <code>WINDKEEL_MERGE=1</code>; until then the console never offers a
          merge, and pull requests are merged on GitHub.
        </p>
      </section>
    );
  }
  const auth = settings.authorization;
  const connect = `${START_PATH}?returnTo=${encodeURIComponent("/settings/merging")}`;
  return (
    <>
      {said ? (
        <Banner intent={said.intent} title={said.intent === "success" ? "Connected" : "Not connected"}>
          <p>{said.text}</p>
        </Banner>
      ) : null}

      <section className="console-section" aria-labelledby="merge-org">
        <h2 id="merge-org">Allow merging from Windkeel</h2>
        <p className="oq-muted" style={muted}>
          When on, people with the <strong>{PERMISSION_LABEL["runs.merge"].label}</strong> permission can merge a verified pull request from its run, as
          themselves. Windkeel merges only the commit that was verified, only on a pass or an acknowledged warn, never a change to <code>.github/workflows</code>,
          and never with an admin bypass — GitHub&rsquo;s branch protection and required reviews still decide. Off by default.
        </p>
        {settings.canManage ? (
          <Toggle id="allow-merge" label="Allow merging from Windkeel" checked={settings.allowMerge} save={setAllowMerging.bind(null, org.id)} />
        ) : (
          <p style={muted}>
            {settings.allowMerge ? "On" : "Off"} for {org.name}. Changing it is an admin&rsquo;s (<code>members.manage</code>).
          </p>
        )}
        <p className="console-guidance-rule">
          The pull request is opened by Windkeel&rsquo;s GitHub App, so the person who merges can also be its only required reviewer. If you want two people,
          require a review from someone other than the merger in GitHub.
        </p>
      </section>

      <section className="console-section" aria-labelledby="merge-github">
        <h2 id="merge-github">Your GitHub authorization</h2>
        {!settings.canMerge ? (
          <p className="oq-muted" style={muted}>
            You don&rsquo;t hold the {PERMISSION_LABEL["runs.merge"].label} permission here, so there&rsquo;s nothing to connect.
          </p>
        ) : auth ? (
          <>
            <p style={muted}>
              Windkeel merges as <strong>@{auth.githubLogin}</strong>
              {auth.status === "valid" ? `, connected ${time(auth.connectedAt)}.` : " — but it needs renewing."}
              {auth.statusReason ? <span className="console-meta"> ({auth.statusReason})</span> : null}
            </p>
            <div className="console-actions">
              {auth.status !== "valid" ? (
                <a className="oq-button oq-button--primary" href={connect}>
                  Connect GitHub again
                </a>
              ) : null}
              <ActionButton label="Disconnect" run={disconnectGithubAuthorization} />
            </div>
            <p className="console-guidance-rule">
              Disconnecting forgets the tokens here. To revoke the grant itself, use GitHub → Settings → Applications → Authorized GitHub Apps.
            </p>
          </>
        ) : settings.githubConnect.configured ? (
          <>
            <p className="oq-muted" style={muted}>
              Once, so Windkeel can merge as you. GitHub asks you to authorize Windkeel&rsquo;s App; authorize with the account you sign in to Windkeel with. Windkeel
              stores the token sealed and never shows it.
            </p>
            <div className="console-actions">
              <a className="oq-button oq-button--primary" href={connect}>
                Connect GitHub to merge
              </a>
            </div>
          </>
        ) : (
          <p className="oq-muted" style={muted}>
            This deployment can&rsquo;t finish a GitHub authorization yet: it needs the App&rsquo;s client id and secret and a sealing key (see{" "}
            <code>docs/github-app.md</code>).
          </p>
        )}
      </section>
    </>
  );
}
