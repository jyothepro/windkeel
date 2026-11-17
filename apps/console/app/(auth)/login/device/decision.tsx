"use client";

import { useState, useTransition } from "react";
import { decide, type DeviceDecision } from "./actions.ts";

export function DeviceDecisionButtons({ userCode, admin }: { userCode: string; admin: boolean }) {
  const [result, setResult] = useState<DeviceDecision | null>(null);
  const [pending, start] = useTransition();

  if (result?.ok) {
    return result.decision === "approve" ? (
      <div className="oq-banner" data-intent="success" role="status">
        <div>
          <strong className="oq-banner__title">Approved. Go back to your terminal.</strong>
          <p className="oq-banner__body">It finishes signing in within a few seconds. You can close this page.</p>
        </div>
      </div>
    ) : (
      <div className="oq-banner" role="status">
        <div>
          <strong className="oq-banner__title">Denied. Nothing was signed in.</strong>
          <p className="oq-banner__body">If you didn't start this login, someone may have sent you the code — don't approve codes you didn't ask for.</p>
        </div>
      </div>
    );
  }

  const act = (decision: "approve" | "deny") => start(async () => setResult(await decide(userCode, decision)));
  return (
    <div className="oq-stack">
      {result && !result.ok ? (
        <p className="oq-field__error" role="alert">
          {result.message}
        </p>
      ) : null}
      <div className="console-actions" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="oq-button oq-button--lg" disabled={pending} onClick={() => act("deny")}>
          Deny
        </button>
        <button type="button" className="oq-button oq-button--primary oq-button--lg" disabled={pending} aria-busy={pending} onClick={() => act("approve")}>
          {admin ? "Approve with admin access" : "Approve"}
        </button>
      </div>
    </div>
  );
}
