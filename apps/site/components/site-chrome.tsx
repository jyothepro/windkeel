"use client";

import { Toast, ToastRegion, ToastTitle } from "@ui-sdk/react/toast";
import { useEffect } from "react";

export function Toaster() {
  return (
    <ToastRegion side="bottom" align="end" data-agent-hidden="">
      {() => (
        <Toast>
          <ToastTitle />
        </Toast>
      )}
    </ToastRegion>
  );
}

type ModelContextDocument = Document & { modelContext?: { registerTool?: unknown } };

export function AgentBridge() {
  useEffect(() => {
    if (!(document as ModelContextDocument).modelContext?.registerTool) return;
    let unregister: (() => void) | undefined;
    let cancelled = false;
    void import("@ui-sdk/react/agent").then(({ createAgent, registerTools }) => {
      if (cancelled) return;
      unregister = registerTools(createAgent(), { allow: (step) => !step.confirm });
    });
    return () => {
      cancelled = true;
      unregister?.();
    };
  }, []);
  return null;
}
