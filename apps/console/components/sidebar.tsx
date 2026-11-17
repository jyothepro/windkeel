import { unstable_rethrow } from "next/navigation";
import { cache, Suspense } from "react";
import { switchOrganization } from "../app/(settings)/settings/actions.ts";
import { currentOrganization, getIdentity, listInboxRuns } from "../lib/api.ts";
import { supabaseConfig } from "../lib/auth.ts";
import { inboxGroup, nextAction } from "../lib/decision.ts";
import { age } from "../lib/format.ts";
import { dotForRun, stateLabel } from "../lib/run-states.ts";
import type { OrganizationView, RunSummary, SelfView } from "../lib/types.ts";
import { IconChart, IconChevronDown, IconInbox, IconPlus, IconRepo, IconSettings, IconSignOut, IconTasks } from "./icons.tsx";
import { CommandSearchButton } from "./command-palette.tsx";
import { Menu } from "./menu.tsx";
import { NavLink } from "./nav-link.tsx";
import { Skeleton } from "./skeleton.tsx";
import { StatusDot } from "./status.tsx";

const initial = (name: string) => name.trim().charAt(0).toUpperCase() || "?";

function RunRow({ run, yours }: { run: RunSummary; yours: boolean }) {
  return (
    <NavLink href={`/runs/${run.id}`} title={run.taskTitle} className="oq-nav-item console-run-link">
      <StatusDot dot={dotForRun(run.status, run.finalVerdict)} dotOnly>
        {stateLabel(run.status)}
      </StatusDot>
      <span className="console-run-link__text">
        <span className="oq-nav-item__label">{run.taskTitle}</span>
        <span className="console-run-link__next" data-yours={yours}>
          {nextAction({ ...run, state: run.status })}
        </span>
      </span>
      <span className="oq-nav-item__meta">{age(run.createdAt)}</span>
    </NavLink>
  );
}

function Group({ label, runs, yours }: { label: string; runs: RunSummary[]; yours?: boolean }) {
  if (runs.length === 0) return null;
  return (
    <div className="oq-nav-group">
      <div className="console-sidebar__group">
        {label}
        <span className="console-count">{runs.length}</span>
      </div>
      {runs.map((r) => (
        <RunRow key={r.id} run={r} yours={Boolean(yours)} />
      ))}
    </div>
  );
}

function Organization({ identity, org }: { identity: SelfView | null; org: OrganizationView | null }) {
  const name = org?.name ?? "Windkeel";
  const face = (
    <>
      <span className="console-org__mark" aria-hidden="true">
        {org ? initial(org.name) : <span className="console-mark" />}
      </span>
      <span className="console-org__name">{name}</span>
    </>
  );
  if (!identity || identity.organizations.length < 2) return <div className="console-org">{face}</div>;
  return (
    <Menu
      label={`Organization: ${name}. Switch organization`}
      className="console-org console-org--switch"
      summary={
        <>
          {face}
          <IconChevronDown small />
        </>
      }
    >
      <div className="oq-nav-group__label">Organizations</div>
      {identity.organizations.map((o) => (
        <form key={o.id} action={switchOrganization}>
          <input type="hidden" name="orgId" value={o.id} />
          <button type="submit" className="oq-nav-item" aria-current={o.id === org?.id ? "page" : undefined}>
            <span className="console-org__mark" aria-hidden="true">
              {initial(o.name)}
            </span>
            <span className="oq-nav-item__label">{o.name}</span>
            <span className="oq-nav-item__meta">{o.id === org?.id ? "in use" : o.role}</span>
          </button>
        </form>
      ))}
    </Menu>
  );
}

function Who({ identity }: { identity: SelfView | null }) {
  const signIn = supabaseConfig() !== null;
  const name = identity?.principal.displayName ?? "Settings";
  const login = identity?.principal.githubLogin ? `@${identity.principal.githubLogin}` : (identity?.account.name ?? null);
  return (
    <div className="console-sidebar__who">
      <Menu
        label={`Signed in as ${name}`}
        className="console-who"
        summary={
          <>
            <span className="oq-avatar" aria-hidden="true">
              {initial(name)}
            </span>
            <span className="console-who__text">
              <span className="console-who__name">{name}</span>
              {login ? <span className="console-who__login">{login}</span> : null}
            </span>
          </>
        }
      >
        <a className="oq-nav-item" href="/settings">
          <IconSettings />
          <span className="oq-nav-item__label">Settings</span>
        </a>
        {signIn ? (
          <form action="/auth/sign-out" method="post">
            <button type="submit" className="oq-nav-item">
              <IconSignOut />
              <span className="oq-nav-item__label">Sign out</span>
            </button>
          </form>
        ) : null}
      </Menu>
      <a className="oq-button oq-button--ghost oq-button--sm oq-button--icon" href="/settings" aria-label="Settings" title="Settings">
        <IconSettings />
      </a>
    </div>
  );
}

const sidebarData = cache(async () => {
  let runs: RunSummary[] = [];
  let identity: SelfView | null = null;
  let org: OrganizationView | null = null;
  let unavailable: string | null = null;
  try {
    identity = await getIdentity();
    org = await currentOrganization(identity);
    runs = await listInboxRuns();
  } catch (err) {
    unstable_rethrow(err);
    unavailable = err instanceof Error ? err.message : "The control plane didn't answer.";
  }
  return {
    identity,
    org,
    unavailable,
    decide: runs.filter((r) => inboxGroup(r.status) === "decide"),
    review: runs.filter((r) => inboxGroup(r.status) === "review"),
    working: runs.filter((r) => inboxGroup(r.status) === "in_progress"),
  };
});

async function SidebarOrganization() {
  const { identity, org } = await sidebarData();
  return <Organization identity={identity} org={org} />;
}

async function NeedsYou() {
  const { decide, review } = await sidebarData();
  const needsYou = decide.length + review.length;
  return needsYou ? <span className="oq-nav-item__meta console-needs">{needsYou}</span> : null;
}

async function SidebarRuns() {
  const { decide, review, working, unavailable } = await sidebarData();
  return (
    <>
      <Group label="Needs your decision" runs={decide} yours />
      <Group label="Ready to review" runs={review} yours />
      <Group label="In progress" runs={working} />
      {unavailable ? (
        <p className="console-sidebar__empty" role="status">
          Runs unavailable. {unavailable}
        </p>
      ) : decide.length + review.length + working.length === 0 ? (
        <p className="console-sidebar__empty">Nothing in flight.</p>
      ) : null}
    </>
  );
}

async function SidebarWho() {
  const { identity } = await sidebarData();
  return <Who identity={identity} />;
}

function RunsSkeleton() {
  return (
    <div className="oq-nav-group" aria-busy="true">
      <div className="console-sidebar__group">
        <Skeleton width="7rem" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="oq-nav-item console-run-link">
          <Skeleton width={`${70 - i * 12}%`} />
        </div>
      ))}
      <span className="oq-sr-only">Loading runs…</span>
    </div>
  );
}

export function Sidebar() {
  return (
    <nav id="console-sidebar" className="console-sidebar" aria-label="Runs and destinations">
      <div className="console-sidebar__top">
        <Suspense
          fallback={
            <div className="console-org">
              <span className="console-org__mark" aria-hidden="true">
                <span className="console-mark" />
              </span>
              <Skeleton width="7rem" />
            </div>
          }
        >
          <SidebarOrganization />
        </Suspense>
      </div>

      <div className="oq-nav-group">
        <NavLink href="/tasks/new" exact>
          <IconPlus />
          <span className="oq-nav-item__label">New task</span>
        </NavLink>
        <CommandSearchButton />
        <NavLink href="/runs" exact>
          <IconInbox />
          <span className="oq-nav-item__label">Inbox</span>
          <Suspense fallback={null}>
            <NeedsYou />
          </Suspense>
        </NavLink>
        <NavLink href="/tasks" exact>
          <IconTasks />
          <span className="oq-nav-item__label">Tasks</span>
        </NavLink>
        <NavLink href="/batches">
          <IconTasks />
          <span className="oq-nav-item__label">Batches</span>
        </NavLink>
        <NavLink href="/repositories">
          <IconRepo />
          <span className="oq-nav-item__label">Repositories</span>
        </NavLink>
        <NavLink href="/metrics">
          <IconChart />
          <span className="oq-nav-item__label">Metrics</span>
        </NavLink>
      </div>

      <div className="console-sidebar__runs">
        <div className="console-sidebar__heading">
          <span>Runs</span>
          <a className="oq-button oq-button--ghost oq-button--sm oq-button--icon" href="/tasks/new" aria-label="New task" title="New task">
            <IconPlus small />
          </a>
        </div>
        <Suspense fallback={<RunsSkeleton />}>
          <SidebarRuns />
        </Suspense>
      </div>

      <Suspense
        fallback={
          <div className="console-sidebar__who">
            <Skeleton width="9rem" height="1.6rem" />
          </div>
        }
      >
        <SidebarWho />
      </Suspense>
    </nav>
  );
}
