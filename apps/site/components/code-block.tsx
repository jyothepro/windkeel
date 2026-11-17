"use client";

import { Button } from "@ui-sdk/react/button";
import { toast } from "@ui-sdk/react/toast";
import { CopyIcon } from "./icons.tsx";

function Line({ text }: { text: string }) {
  const hash = text.indexOf("  #");
  if (hash === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, hash)}
      <span className="tok-comment">{text.slice(hash)}</span>
    </>
  );
}

export function CodeBlock({ code, label, copyLabel }: { code: string; label: string; copyLabel: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Couldn't copy. Select the text and copy it instead.");
    }
  }

  return (
    <div className="relative">
      <pre className="code pr-14" aria-label={label} tabIndex={0}>
        <code>
          {code.split("\n").map((line, index) => (
            <span key={`${index}:${line}`} className="block">
              <Line text={line} />
            </span>
          ))}
        </code>
      </pre>
      <Button
        onClick={copy}
        aria-label={copyLabel}
        title="Copy"
        className="absolute right-2 top-2 inline-flex size-11 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
      >
        <CopyIcon />
      </Button>
    </div>
  );
}
