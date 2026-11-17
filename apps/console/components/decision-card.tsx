"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { approve, cancel, handBack, mergePullRequest, runAgain, runAgainWith, submit, takeOver, type CommandResult } from "../app/(console)/runs/[id]/actions.ts";
import { MERGE_METHODS, attemptLine, mergeButtonLabel, type MergeEligibility } from "../lib/merge.ts";
import { shortSha } from "../lib/format.ts";
import type { ModelPicker } from "../lib/model-picker.ts";
import { ModelPickerFields } from "./model-picker.tsx";
import { runCommands, type RunCommand } from "../lib/command-search.ts";
import type { Decision, DecisionAction } from "../lib/decision.ts";
import type { RunState } from "../lib/run-states.ts";
import { useRunCommands } from "./command-palette.tsx";
import { IconExternal } from "./icons.tsx";

export function DecisionCard({
  runId,
  taskId,
  title,
  state,
  decision,
  pullRequestUrl,
  picker = null,
  merge = null,
}: {
  runId: string;
  taskId: string;
  title: string;
  state: RunState;
  decision: Decision;
  pullRequestUrl: string | null;
  picker?: ModelPicker | null;
  merge?: MergeEligibility | null;
}) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const againDialog = useRef<HTMLDialogElement>(null);
  const mergeDialog = useRef<HTMLDialogElement>(null);
  const isDraft = merge?.isDraft === true;
  const attempt = merge?.merge ?? null;
  useEffect(() => {
    if (attempt?.status !== "pending") return;
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [attempt?.status, router]);
  const canRunAgain = decision.primary === "run_again" || decision.secondary === "run_again";
  const sentinel = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [reason, setReason] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const inFlight = useRef(false);

  const run = (fn: () => Promise<CommandResult>, after?: (r: CommandResult & { ok: true }) => void) => {
    if (inFlight.current) return;
    inFlight.current = true;
    start(async () => {
      try {
        setRefusal(null);
        const res = await fn();
        if (!res.ok) setRefusal(res.message);
        else after?.(res);
      } finally {
        inFlight.current = false;
      }
    });
  };

  const perform = (command: RunCommand) => {
    if (command === "approve") run(() => approve(runId));
    else if (command === "run_again") run(() => runAgain(runId, taskId), (r) => r.runId && router.push(`/runs/${r.runId}`));
    else dialog.current?.showModal();
  };
  useRunCommands(runId, title, runCommands(state), perform);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setCollapsed(!entry!.isIntersecting && entry!.boundingClientRect.top < 0));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const button = (action: DecisionAction, primary: boolean) => {
    const cls = primary ? "oq-button oq-button--primary" : "oq-button";
    switch (action) {
      case "approve":
        return (
          <button key={action} type="button" className={cls} aria-busy={pending} disabled={pending} onClick={() => perform("approve")}>
            {pending ? <span className="oq-spinner" aria-hidden="true" /> : null}
            Approve criteria
          </button>
        );
      case "open_pull_request":
        return pullRequestUrl ? (
          <a key={action} className={cls} href={pullRequestUrl} target="_blank" rel="noreferrer">
            Open pull request
            <IconExternal />
          </a>
        ) : null;
      case "run_again":
        return (
          <button
            key={action}
            type="button"
            className={cls}
            aria-busy={pending}
            disabled={pending}
            onClick={() => perform("run_again")}
          >
            Run again
          </button>
        );
      case "guide":
        return (
          <a key={action} className={cls} href="#guidance">
            Steer this run
          </a>
        );
      case "cancel":
        return (
          <button key={action} type="button" className="oq-button oq-button--ghost" onClick={() => dialog.current?.showModal()}>
            Cancel run
          </button>
        );
      case "take_over":
      case "make_changes":
        return (
          <button
            key={action}
            type="button"
            className={cls}
            aria-busy={pending}
            disabled={pending}
            title={action === "take_over" ? "Windkeel stops after this turn, commits its work, and gives you a workspace of your own" : "Opens a workspace on the pull request's head; submitting re-verifies and updates the same pull request"}
            onClick={() => run(() => takeOver(runId))}
          >
            {action === "take_over" ? "Take over" : "Make changes"}
          </button>
        );
      case "submit":
        return (
          <button key={action} type="button" className={cls} aria-busy={pending} disabled={pending} onClick={() => run(() => submit(runId))}>
            {pending ? <span className="oq-spinner" aria-hidden="true" /> : null}
            Submit for verification
          </button>
        );
      case "hand_back":
        return (
          <button key={action} type="button" className={cls} aria-busy={pending} disabled={pending} onClick={() => run(() => handBack(runId))}>
            Hand back to Windkeel
          </button>
        );
      case "merge":
        return merge ? (
          <button
            key={action}
            type="button"
            className={cls}
            disabled={pending || attempt?.status === "pending"}
            onClick={() => mergeDialog.current?.showModal()}
          >
            {mergeButtonLabel(isDraft)}
          </button>
        ) : null;
    }
  };

  return (
    <>
      <div ref={sentinel} className="console-decision__sentinel" aria-hidden="true" />
      <section className="console-decision" data-needed={decision.needed} data-collapsed={collapsed} aria-labelledby={`decision-${runId}`}>
        <div className="console-decision__text">
          <h2 id={`decision-${runId}`}>
            {collapsed ? (
              <button type="button" className="console-decision__line" title="Show the whole decision" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
                {decision.needs}
              </button>
            ) : (
              decision.needs
            )}
          </h2>
          {collapsed ? null : (
            <>
              <p>{decision.why}</p>
              {decision.recommended ? (
                <p>
                  <span className="console-decision__label">Recommended</span> {decision.recommended}
                </p>
              ) : null}
              {decision.consequence ? (
                <p>
                  <span className="console-decision__label">Then</span> {decision.consequence}
                </p>
              ) : null}
            </>
          )}
        </div>
        <div className="console-actions">
          {decision.primary ? button(decision.primary, true) : null}
          {decision.secondary && !collapsed ? button(decision.secondary, false) : null}
          {!collapsed ? (decision.also ?? []).map((action) => button(action, false)) : null}
          {canRunAgain && picker && !collapsed ? (
            <button type="button" className="oq-button oq-button--ghost" disabled={pending} onClick={() => againDialog.current?.showModal()}>
              Run again with…
            </button>
          ) : null}
        </div>
        {refusal ? (
          <p className="oq-field__error console-decision__refusal" role="alert">
            {refusal}
          </p>
        ) : null}
        {!collapsed && attemptLine(attempt) ? (
          <p className="console-guidance-rule" role="status" data-merge-attempt={attempt?.status}>
            {attemptLine(attempt)}
          </p>
        ) : null}
        {merge && merge.eligible ? (
          <dialog ref={mergeDialog} className="oq-dialog" aria-labelledby={`merge-${runId}`}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                mergeDialog.current?.close();
                run(() => mergePullRequest(runId, data), () => router.refresh());
              }}
            >
              <div className="oq-dialog__header">
                <h2 className="oq-dialog__title" id={`merge-${runId}`}>
                  {isDraft ? "Mark ready and merge" : "Merge"} pull request{merge.prNumber ? ` #${merge.prNumber}` : ""}?
                </h2>
              </div>
              <div className="oq-dialog__body oq-stack" style={{ ["--gap" as string]: "var(--space-3)" }}>
                <p>
                  Windkeel merges the verified commit <span className="oq-mono">{merge.verifiedSha ? shortSha(merge.verifiedSha) : "—"}</span>
                  {merge.authorization ? (
                    <>
                      {" "}
                      as <strong>@{merge.authorization.githubLogin}</strong>
                    </>
                  ) : null}
                  , with your GitHub authorization. GitHub&rsquo;s branch protection and required reviews still apply, and if a commit lands after
                  verification GitHub refuses the merge.
                </p>
                <p>
                  If GitHub lets you bypass this repository&rsquo;s protection (as an admin, or on a ruleset&rsquo;s bypass list), Windkeel refuses to
                  merge as you, because it couldn&rsquo;t guarantee the protection applies.
                </p>
                {isDraft ? <p>It&rsquo;s a draft: it is marked ready for review first, as you, then merged.</p> : null}
                <input type="hidden" name="markReady" value={isDraft ? "true" : "false"} />
                {merge.needsAcknowledgement.length > 0 ? (
                  <fieldset className="console-checks">
                    <legend className="oq-field__label">Verified with warnings — confirm you&rsquo;ve looked at each</legend>
                    {merge.needsAcknowledgement.map((item) => (
                      <label key={item.id} className="console-choice__item">
                        <input type="checkbox" name="ack" value={item.id} required />
                        <span className="console-choice__label">{item.title ?? item.id}</span>
                      </label>
                    ))}
                  </fieldset>
                ) : null}
                <div className="oq-field">
                  <label className="oq-field__label" htmlFor={`merge-method-${runId}`}>
                    How
                  </label>
                  <select id={`merge-method-${runId}`} name="mergeMethod" className="oq-input" defaultValue="squash">
                    {MERGE_METHODS.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <p className="oq-field__hint">The repository must allow it on GitHub.</p>
                </div>
              </div>
              <div className="oq-dialog__footer">
                <button type="button" className="oq-button" onClick={() => mergeDialog.current?.close()}>
                  Not now
                </button>
                <button type="submit" className="oq-button oq-button--primary" disabled={pending}>
                  {isDraft ? "Mark ready and merge" : "Merge"}
                </button>
              </div>
            </form>
          </dialog>
        ) : null}
        {canRunAgain && picker ? (
          <dialog ref={againDialog} className="oq-dialog" aria-labelledby={`again-${runId}`}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                againDialog.current?.close();
                run(() => runAgainWith(runId, taskId, data), (r) => r.runId && router.push(`/runs/${r.runId}`));
              }}
            >
              <div className="oq-dialog__header">
                <h2 className="oq-dialog__title" id={`again-${runId}`}>
                  Run again with…
                </h2>
              </div>
              <div className="oq-dialog__body oq-stack" style={{ ["--gap" as string]: "var(--space-3)" }}>
                <p>A new run of the same task, against the same criteria, on the models you pick. This run keeps what it ran on.</p>
                <ModelPickerFields picker={picker} idPrefix={`again-${runId}`} rerun />
              </div>
              <div className="oq-dialog__footer">
                <button type="button" className="oq-button" onClick={() => againDialog.current?.close()}>
                  Not now
                </button>
                <button type="submit" className="oq-button oq-button--primary" disabled={pending}>
                  Start the new run
                </button>
              </div>
            </form>
          </dialog>
        ) : null}
        <dialog ref={dialog} className="oq-dialog" aria-labelledby={`cancel-${runId}`}>
          <form
            method="dialog"
            onSubmit={(e) => {
              if ((e.nativeEvent).submitter?.getAttribute("value") !== "confirm") return;
              run(() => cancel(runId, reason));
            }}
          >
            <div className="oq-dialog__header">
              <h2 className="oq-dialog__title" id={`cancel-${runId}`}>
                Stop this run?
              </h2>
            </div>
            <div className="oq-dialog__body oq-stack" style={{ ["--gap" as string]: "var(--space-3)" }}>
              <p>The run stops where it is and can't be resumed. Its evidence and cost so far are kept.</p>
              <div className="oq-field">
                <label className="oq-field__label" htmlFor={`reason-${runId}`}>
                  Reason (optional)
                </label>
                <input id={`reason-${runId}`} className="oq-input" value={reason} onChange={(e) => setReason(e.target.value)} />
                <p className="oq-field__hint">Recorded with the cancellation.</p>
              </div>
            </div>
            <div className="oq-dialog__footer">
              <button type="submit" value="keep" className="oq-button" autoFocus>
                Keep running
              </button>
              <button type="submit" value="confirm" className="oq-button oq-button--danger" disabled={pending}>
                Stop run
              </button>
            </div>
          </form>
        </dialog>
      </section>
    </>
  );
}
