"use client";

import { createLocalStorage, createPreference } from "@ui-sdk/core";
import { Preferences, usePreference } from "@ui-sdk/react/preferences";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import { MonitorIcon, MoonIcon, SunIcon } from "./icons.tsx";

const THEMES = ["system", "light", "dark"] as const;
type Theme = (typeof THEMES)[number];

const theme = createPreference({
  values: THEMES,
  defaultValue: "system",
  attribute: "data-theme",
  global: true,
  storage: createLocalStorage("windkeel-theme"),
});

function isTheme(value: string | null): value is Theme {
  return value !== null && (THEMES as readonly string[]).includes(value);
}

export function ThemePreferences({ children }: { children: React.ReactNode }) {
  return <Preferences preferences={[theme]}>{children}</Preferences>;
}

const OPTIONS: { value: Theme; label: string; icon: React.ReactNode }[] = [
  { value: "system", label: "System", icon: <MonitorIcon /> },
  { value: "light", label: "Light", icon: <SunIcon /> },
  { value: "dark", label: "Dark", icon: <MoonIcon /> },
];

export function ThemeToggle() {
  const { value } = usePreference(theme);
  return (
    <SegmentedControl
      aria-label="Color theme"
      className="theme-toggle"
      value={value}
      onValueChange={(next, details) => {
        if (isTheme(next)) theme.set(next, { reason: "press", event: details.event });
      }}
    >
      <SegmentedControlIndicator />
      {OPTIONS.map((option) => (
        <SegmentedControlItem key={option.value} value={option.value} title={`${option.label} theme`}>
          {option.icon}
          <span className="visually-hidden">{option.label}</span>
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
