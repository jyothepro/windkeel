"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { handBack, openWorkspace, submit, type CommandResult } from "../app/(console)/runs/[id]/actions.ts";
import { editorName, workspaceStatus } from "../lib/takeover.ts";
import type { HumanSession } from "../lib/types.ts";
import { time } from "../lib/format.ts";
import { IconExternal } from "./icons.tsx";

export function HumanWorkspacePanel({ runId, session }: { runId: string; session: HumanSession }) {
  const router = useRouter();
  const status = workspaceStatus(session);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const inFlight = useRef(false);

  const once = (fn: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    start(async () => {
      try {
        setRefusal(null);
        await fn();
      } finally {
        inFlight.current = false;
      }
    });
  };

  const open = () => {
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    once(async () => {
      const res = await openWorkspace(runId);
      if (!res.ok) {
        tab?.close();
        setRefusal(res.message);
        return;
      }
      if (tab) tab.location.replace(res.url);
      else window.open(res.url, "_blank", "noopener,noreferrer");
    });
  };

  const command = (fn: (id: string) => Promise<CommandResult>) =>
    once(async () => {
      const res = await fn(runId);
      if (!res.ok) setRefusal(res.message);
      else router.refresh();
    });

  return (
    <section className="console-section console-human" aria-labelledby="human-workspace" data-tone={status.tone}>
      <h2 id="human-workspace">Workspace</h2>
      <dl className="console-kv">
        <dt>Editing</dt>
        <dd>
          {editorName(session)}
          {session.editor.login && !session.yours ? <span className="console-meta"> · @{session.editor.login}</span> : null}
        </dd>
        <dt>Workspace</dt>
        <dd>{status.line}</dd>
        {session.startedAt ? (
          <>
            <dt>Since</dt>
            <dd>{time(session.startedAt)}</dd>
          </>
        ) : null}
        {session.expiresAt ? (
          <>
            <dt>Deleted at</dt>
            <dd>{time(session.expiresAt)} unless you submit or hand back first</dd>
          </>
        ) : null}
      </dl>
      {session.installNote && (status.tone === "awake" || status.tone === "sleeping") ? (
        <p className="console-meta" role="status">
          {session.installNote} Install them with your own credentials in the terminal if you need them.
        </p>
      ) : null}
      {session.error && status.tone !== "failed" && status.tone !== "ended" ? (
        <p className="oq-field__error" role="alert">
          {session.error}
        </p>
      ) : null}
      <p className="console-meta">
        Install has already run, without repository secrets; no Windkeel credential is in the workspace. Uncommitted editor state isn&rsquo;t kept: submitting
        commits everything in the checkout as you.
      </p>
      {session.yours ? (
        <div className="console-actions">
          {status.openable ? (
            <button type="button" className="oq-button oq-button--primary" aria-busy={pending} disabled={pending} onClick={open}>
              Open workspace
              <IconExternal />
            </button>
          ) : null}
          {status.openable ? (
            <button type="button" className="oq-button" disabled={pending} onClick={() => command(submit)}>
              Submit for verification
            </button>
          ) : null}
          {status.openable && session.canHandBack ? (
            <button type="button" className="oq-button" disabled={pending} onClick={() => command(handBack)}>
              Hand back to Windkeel
            </button>
          ) : null}
        </div>
      ) : (
        <p className="console-meta">Only the person editing can open the workspace, submit or hand back.</p>
      )}
      {refusal ? (
        <p className="oq-field__error" role="alert">
          {refusal}
        </p>
      ) : null}
    </section>
  );
}
