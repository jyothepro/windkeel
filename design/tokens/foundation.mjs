// Windkeel foundation tokens: everything that is not color. The single source for
// tokens/foundation.css and for the design-system export — edit here, then run
// `node design/scripts/build.mjs`.
//
// Windkeel is a dense tool people read for long stretches: transcripts, logs, diffs. So the base
// size is 14px (not 16), the scale steps are small near the body size and wide at the top, and
// mono carries as much weight as sans.

export const fonts = {
  // Hosted on Google Fonts. Plex is built for engineering documents: a sans and a mono drawn as
  // one family, so a path inside a sentence doesn't jump in weight or x-height.
  stylesheet:
    "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,400;0,500;1,400&family=IBM+Plex+Sans:wght@400;500;600&display=swap",
  families: {
    sans: '"IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    mono: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  },
};

// [name, px] — components reference these, never raw pixel sizes.
export const fontSizes = [
  ["xs", 11], ["sm", 12], ["md", 13], ["base", 14], ["lg", 15], ["xl", 18], ["2xl", 24], ["3xl", 32],
];
// Line height paired with each size, plus code-sm for 12px mono (terminal and diff lines).
export const lineHeights = [
  ["xs", 16], ["sm", 16], ["md", 20], ["base", 22], ["lg", 22], ["xl", 26], ["2xl", 32], ["3xl", 40], ["code-sm", 18],
];
export const fontWeights =[["regular", 400], ["medium", 500], ["semibold", 600]];

// Text styles. Each becomes a `.text-<name>` class, and a row in the design system's type table.
export const textStyles = [
  { group: "Display", name: "text-display", family: "sans", size: 32, leading: 40, weight: 600, tracking: "-0.02em",
    usage: "Empty states and onboarding headlines. One per screen at most.", sample: "Every change, verified" },
  { group: "Display", name: "text-title", family: "sans", size: 24, leading: 32, weight: 600, tracking: "-0.015em",
    usage: "Page titles.", sample: "Adopt a run whose execution ended" },
  { group: "Display", name: "text-heading", family: "sans", size: 18, leading: 26, weight: 600, tracking: "-0.01em",
    usage: "Section and panel headings.", sample: "Evidence" },
  { group: "Text", name: "text-subheading", family: "sans", size: 15, leading: 22, weight: 600,
    usage: "Card and dialog titles, session titles in a header bar.", sample: "Security scan" },
  { group: "Text", name: "text-body", family: "sans", size: 14, leading: 22, weight: 400,
    usage: "Default for messages and prose. Keep lines under ~72 characters.", sample: "Reproducing the late merge before changing anything." },
  { group: "Text", name: "text-small", family: "sans", size: 13, leading: 20, weight: 400,
    usage: "Controls, list rows, table cells, secondary copy.", sample: "2 passed · 1 warn" },
  { group: "Text", name: "text-caption", family: "sans", size: 12, leading: 16, weight: 400,
    usage: "Timestamps, metadata, field hints.", sample: "Started 2m ago by codex-worker" },
  { group: "Text", name: "text-overline", family: "sans", size: 11, leading: 16, weight: 500, tracking: "0.06em", upper: true,
    usage: "Group labels in navigation and panels. Always uppercase.", sample: "Active runs" },
  { group: "Code", name: "text-code", family: "mono", size: 13, leading: 20, weight: 400,
    usage: "Paths, commands, identifiers — inline or in blocks.", sample: "src/factory/run-service.ts" },
  { group: "Code", name: "text-code-small", family: "mono", size: 12, leading: 18, weight: 400,
    usage: "Terminal output, diff lines, hashes.", sample: "sha256:9c1e…a07b" },
];

// 4px grid. `_` stands in for a decimal point (space-1_5 = 6px) so names stay valid everywhere.
export const spacing = [
  ["space-0_5", 2, "Hairline gaps: badge icon to text, stacked meta lines."],
  ["space-1", 4, "Icon to label inside a control; tight inline groups."],
  ["space-1_5", 6, "Gap inside buttons and badges."],
  ["space-2", 8, "Gap between sibling controls; list row padding."],
  ["space-3", 12, "Control inline padding; gap between steps in a transcript."],
  ["space-4", 16, "Card and panel padding; gap between messages."],
  ["space-5", 20, "Padding of dialogs and the composer."],
  ["space-6", 24, "Gap between sections within a panel."],
  ["space-8", 32, "Gap between page sections."],
  ["space-10", 40, "Page gutters on wide screens."],
  ["space-12", 48, "Separation of major regions."],
  ["space-16", 64, "Empty-state breathing room."],
];

export const radius = [
  ["radius-xs", 3, "Inline code, keyboard keys, diff emphasis."],
  ["radius-sm", 5, "Checkbox, small chips, nav items."],
  ["radius-md", 7, "Buttons, inputs, agent steps."],
  ["radius-lg", 10, "Cards, panels, terminals, the composer."],
  ["radius-xl", 14, "Dialogs and toasts."],
  ["radius-full", 9999, "Badges, avatars, status dots, switches."],
];

// Per theme. Dark shadows are heavier and carry a 1px light edge, because a dark shadow on a
// dark page is nearly invisible — the edge is what actually separates the layer.
export const shadows = [
  ["shadow-xs", "Resting controls: secondary buttons, inputs.",
    { light: "0 1px 2px #0f11170d", dark: "0 1px 2px #00000066" }],
  ["shadow-sm", "Cards that can be dragged or picked up.",
    { light: "0 1px 2px #0f11170f, 0 1px 3px #0f11171a", dark: "0 1px 3px #00000080, 0 0 0 1px #ffffff0a" }],
  ["shadow-md", "Menus, popovers, the toast.",
    { light: "0 4px 12px #0f11171a, 0 1px 3px #0f11170f", dark: "0 8px 24px #00000099, 0 0 0 1px #ffffff0f" }],
  ["shadow-lg", "Dialogs.",
    { light: "0 16px 40px #0f11172e, 0 2px 6px #0f11171a", dark: "0 20px 48px #000000b3, 0 0 0 1px #ffffff14" }],
];

export const sizes = [
  ["control-sm", 28, "Height of small buttons and inputs: toolbars, dense rows."],
  ["control-md", 32, "Default height of buttons, inputs, tabs."],
  ["control-lg", 40, "Primary call to action on empty states and dialogs."],
  ["icon-sm", 14, "Icons in small controls and badges."],
  ["icon-md", 16, "Default icon size."],
];

export const layout = [
  ["sidebar-width", 248, "Run list on the left of the app shell."],
  ["panel-width", 400, "Evidence panel on the right of the app shell."],
  ["content-max", 760, "Max width of the transcript column."],
];

export const zIndex = [
  ["z-sticky", 10, "Sticky headers inside scroll areas."],
  ["z-dropdown", 20, "Menus and popovers."],
  ["z-overlay", 40, "Dialog scrim."],
  ["z-modal", 50, "Dialogs."],
  ["z-toast", 60, "Toasts, above everything."],
];

// CSS only: the design-system format has no motion family, so the README carries these.
export const motion = [
  ["duration-fast", "120ms", "Hover and press color changes."],
  ["duration-base", "200ms", "Expand, collapse, switch thumb."],
  ["duration-slow", "320ms", "Dialogs and toasts entering."],
  ["ease-standard", "cubic-bezier(0.2, 0, 0, 1)", "Most transitions."],
  ["ease-out", "cubic-bezier(0, 0, 0.2, 1)", "Things entering the screen."],
];
