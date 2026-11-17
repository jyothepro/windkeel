"use client";

import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import { useState } from "react";

type Mode = "managed" | "byok";

const PLANS = [
  { name: "Starter", price: 20, credits: 2000 },
  { name: "Pro", price: 50, credits: 5250 },
  { name: "Team", price: 100, credits: 11000 },
  { name: "Scale", price: 250, credits: 30000 },
] as const;

const number = new Intl.NumberFormat("en-US");

export function PricingPlans() {
  const [mode, setMode] = useState<Mode>("managed");

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl
          aria-label="Which models run your work"
          value={mode}
          onValueChange={(next) => {
            if (next === "managed" || next === "byok") setMode(next);
          }}
        >
          <SegmentedControlIndicator />
          <SegmentedControlItem value="managed">Windkeel models</SegmentedControlItem>
          <SegmentedControlItem value="byok">Your own model key</SegmentedControlItem>
        </SegmentedControl>
        <p className="max-w-md text-sm text-muted" aria-live="polite">
          {mode === "managed"
            ? "Credits pay for sandbox compute and for AI on Windkeel's models, billed at cost."
            : "Bring your own model key and you pay for compute only. Credits go to sandbox minutes."}
        </p>
      </div>

      <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {PLANS.map((plan) => (
          <li key={plan.name} className="card flex flex-col p-6">
            <h3 className="text-base font-semibold">{plan.name}</h3>
            <p className="mt-4 flex items-baseline gap-1">
              <span className="text-4xl font-semibold tracking-tight tabular-nums">${plan.price}</span>
              <span className="text-sm text-muted">/ month</span>
            </p>
            <p className="mt-2 text-sm font-medium tabular-nums">{number.format(plan.credits)} credits a month</p>
            <p className="mt-1 text-sm text-muted">
              {mode === "byok"
                ? `Up to ${number.format(plan.credits / 2)} sandbox-minutes of compute.`
                : `Compute and AI at cost. Minutes depend on how much AI your runs use.`}
            </p>
            <a href="/request-access" className="btn btn-secondary mt-6 w-full" aria-label={`Request access to ${plan.name}`}>
              Request access
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
