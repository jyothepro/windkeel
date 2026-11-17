"use client";

import { Button } from "@ui-sdk/react/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { Select, SelectContent, SelectItem, SelectItemIndicator, SelectTrigger, SelectValue } from "@ui-sdk/react/select";
import { Textarea } from "@ui-sdk/react/textarea";
import { useRef, useState } from "react";
import { HONEYPOT_FIELD, LIMITS, TEAM_SIZES, type FieldName } from "../lib/request-access.ts";
import { CheckIcon, ChevronDownIcon } from "./icons.tsx";

type Status = { kind: "idle" } | { kind: "error"; message: string } | { kind: "done" };
type ServerReply = { ok?: boolean; error?: string; fields?: Partial<Record<FieldName, string>> };

const TEAM_SIZE_LABELS: Record<(typeof TEAM_SIZES)[number], string> = {
  "1-10": "1 to 10 engineers",
  "11-50": "11 to 50 engineers",
  "51-200": "51 to 200 engineers",
  "201-1000": "201 to 1,000 engineers",
  "1000+": "More than 1,000 engineers",
};

export function RequestAccessForm() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [pending, setPending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldName, string>>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);

  function clear(name: FieldName) {
    setFieldErrors((current) => {
      if (!(name in current)) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  }

  async function submit() {
    const form = formRef.current;
    if (!form) return;
    if (!form.reportValidity()) return;
    const body = Object.fromEntries(new FormData(form));
    setPending(true);
    try {
      const response = await fetch("/api/request-access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const reply = (await response.json().catch(() => ({}))) as ServerReply;
      if (response.ok && reply.ok) {
        setStatus({ kind: "done" });
        return;
      }
      setFieldErrors(reply.fields ?? {});
      setStatus({ kind: "error", message: reply.error ?? "Something went wrong. Try again in a minute." });
    } catch {
      setStatus({ kind: "error", message: "We couldn't reach the server. Check your connection and try again." });
    } finally {
      setPending(false);
    }
    requestAnimationFrame(() => statusRef.current?.focus());
  }

  if (status.kind === "done") {
    return (
      <div role="status" className="card p-6 md:p-8">
        <p className="flex items-center gap-2 text-lg font-semibold">
          <CheckIcon className="text-pass" size={20} /> Request received
        </p>
        <p className="mt-2 text-muted">
          Thanks. We&apos;ll write to you when there&apos;s a place for your team. In the meantime, Windkeel Gate is open
          source and runs in your own CI.
        </p>
        <a href="/#gate-cloud" className="btn btn-secondary mt-6">
          Read about Gate
        </a>
      </div>
    );
  }

  return (
    <form
      ref={formRef}
      className="card grid gap-6 p-6 md:p-8"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {status.kind === "error" ? (
        <div
          ref={statusRef}
          tabIndex={-1}
          role="alert"
          className="rounded-lg border border-fail-edge bg-fail-soft px-4 py-3 text-sm text-fail"
        >
          {status.message}
        </div>
      ) : null}

      <Field name="email" invalid={fieldErrors.email ? true : undefined}>
        <FieldLabel>Work email</FieldLabel>
        <Input type="email" required autoComplete="email" maxLength={LIMITS.email} onValueChange={() => clear("email")} />
        <FieldError>{(state) => fieldErrors.email ?? state.message}</FieldError>
      </Field>

      <Field name="company" invalid={fieldErrors.company ? true : undefined}>
        <FieldLabel>Company</FieldLabel>
        <Input required autoComplete="organization" maxLength={LIMITS.company} onValueChange={() => clear("company")} />
        <FieldError>{(state) => fieldErrors.company ?? state.message}</FieldError>
      </Field>

      <Field name="teamSize" invalid={fieldErrors.teamSize ? true : undefined}>
        <FieldLabel>Engineering team size</FieldLabel>
        <Select
          required
          placeholder="Choose a size"
          items={TEAM_SIZES.map((size) => ({ value: size, label: TEAM_SIZE_LABELS[size] }))}
          onValueChange={() => clear("teamSize")}
        >
          <SelectTrigger>
            <SelectValue />
            <ChevronDownIcon className="text-muted" />
          </SelectTrigger>
          <SelectContent>
            {TEAM_SIZES.map((size) => (
              <SelectItem key={size} value={size}>
                {TEAM_SIZE_LABELS[size]}
                <SelectItemIndicator>
                  <CheckIcon />
                </SelectItemIndicator>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldError>{(state) => fieldErrors.teamSize ?? state.message}</FieldError>
      </Field>

      <Field name="agents" invalid={fieldErrors.agents ? true : undefined}>
        <FieldLabel>Coding agents you use</FieldLabel>
        <Textarea required maxLength={LIMITS.agents} rows={3} onValueChange={() => clear("agents")} />
        <FieldDescription>For example Claude Code, Codex, OpenCode, or none yet.</FieldDescription>
        <FieldError>{(state) => fieldErrors.agents ?? state.message}</FieldError>
      </Field>

      <div aria-hidden="true" data-agent-hidden="" className="visually-hidden">
        <label>
          Leave this empty
          <input type="text" name={HONEYPOT_FIELD} tabIndex={-1} autoComplete="off" defaultValue="" />
        </label>
      </div>

      <div>
        <Button
          type="submit"
          className="btn btn-primary w-full sm:w-auto"
          disabled={pending}
          focusableWhenDisabled
          aria-busy={pending || undefined}
        >
          {pending ? "Sending…" : "Send request"}
        </Button>
      </div>
    </form>
  );
}
