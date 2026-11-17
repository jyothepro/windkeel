#!/usr/bin/env node
// Generates the Windkeel color tokens from a handful of OKLCH parameters.
//
//   node design/scripts/generate-colors.mjs          # write design/tokens/color.{json,css}
//   node design/scripts/generate-colors.mjs --check  # verify contrast, write nothing
//
// Every scale has 12 steps with fixed jobs (after Radix Colors), so a component picks a step by
// what it is doing, never by eyeballing a shade:
//
//    1 app background        5 active / selected bg     9 solid fill (buttons, badges)
//    2 subtle background     6 subtle border           10 solid fill, hovered
//    3 element background    7 border                  11 low-contrast text
//    4 element hovered       8 strong border / focus   12 high-contrast text
//
// Lightness is shared across hues within a mode, so "blue-3" and "red-3" sit at the same visual
// weight. Chroma follows a curve that peaks at the solid steps. Colors outside sRGB are pulled
// back by reducing chroma, never lightness, so the lightness ladder always holds.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------------------------
// Parameters

const LIGHTNESS = {
  light: [0.993, 0.982, 0.962, 0.94, 0.915, 0.882, 0.832, 0.752, null, null, 0.5, 0.26],
  dark: [0.155, 0.178, 0.212, 0.243, 0.274, 0.315, 0.378, 0.47, null, null, 0.8, 0.95],
};
const CHROMA_CURVE = {
  light: [0.03, 0.07, 0.13, 0.2, 0.28, 0.36, 0.46, 0.62, 1, 1, 0.9, 0.5],
  dark: [0.1, 0.14, 0.24, 0.32, 0.4, 0.48, 0.56, 0.7, 1, 1, 0.8, 0.3],
};
const NEUTRAL_CURVE = {
  light: [0.15, 0.3, 0.45, 0.55, 0.65, 0.75, 0.85, 0.9, 1, 1, 1, 1],
  dark: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 1, 1, 0.6, 0.3],
};

// `solid` is step 9 (L, C); step 10 is derived from it. `onSolid` is the text color that sits
// on step 9. Neutral uses its own near-zero chroma, fading out toward the page so the lightest
// backgrounds read as white rather than pale blue.
const HUES = {
  // Graphite: the whole UI shell. A faint blue cast keeps it from reading as dead gray.
  neutral: { h: 264, chroma: 0.011, solid: { light: [0.64, 0.012], dark: [0.64, 0.012] }, onSolid: "dark" },
  // Iris: the brand accent — primary actions, selection, focus, links.
  iris: { h: 280, peak: 0.2, solid: { light: [0.53, 0.2], dark: [0.55, 0.2] }, onSolid: "white" },
  // Cyan: the agent. Anything the agent is doing right now (thinking, running a tool, streaming).
  cyan: { h: 205, peak: 0.12, solid: { light: [0.76, 0.13], dark: [0.76, 0.13] }, onSolid: "dark" },
  green: { h: 152, peak: 0.16, solid: { light: [0.55, 0.14], dark: [0.55, 0.14] }, onSolid: "white" },
  amber: { h: 72, peak: 0.16, solid: { light: [0.8, 0.165], dark: [0.8, 0.165] }, onSolid: "dark" },
  red: { h: 25, peak: 0.2, solid: { light: [0.56, 0.2], dark: [0.56, 0.2] }, onSolid: "white" },
  blue: { h: 245, peak: 0.16, solid: { light: [0.55, 0.17], dark: [0.54, 0.17] }, onSolid: "white" },
};

// ---------------------------------------------------------------------------------------------
// OKLCH -> sRGB

function oklchToLinearSrgb(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

function toHex(L, C, h) {
  let lin = oklchToLinearSrgb(L, C, h);
  for (let c = C; !inGamut(lin) && c > 0; c -= 0.002) lin = oklchToLinearSrgb(L, c, h);
  const encode = (v) => {
    v = Math.min(1, Math.max(0, v));
    const s = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(s * 255).toString(16).padStart(2, "0");
  };
  return "#" + lin.map(encode).join("");
}

// WCAG 2 contrast, computed from the hex that actually ships.
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// ---------------------------------------------------------------------------------------------
// Scales

function scale(name, mode) {
  const hue = HUES[name];
  const [sL, sC] = hue.solid[mode];
  return LIGHTNESS[mode].map((L, i) => {
    if (i === 8) return toHex(sL, sC, hue.h);
    // Hover darkens in both modes. Lightening in dark mode reads better on a black page, but
    // it pushes white text on green/red/blue below 4.5:1, and a hover must stay legible.
    if (i === 9) return toHex(sL - 0.045, sC, hue.h);
    const C = name === "neutral" ? hue.chroma * NEUTRAL_CURVE[mode][i] : hue.peak * CHROMA_CURVE[mode][i];
    return toHex(L, C, hue.h);
  });
}

const modes = ["light", "dark"];
const scales = Object.fromEntries(
  modes.map((mode) => [mode, Object.fromEntries(Object.keys(HUES).map((n) => [n, scale(n, mode)]))]),
);

// ---------------------------------------------------------------------------------------------
// Semantic tokens: what components use. Values are references into the scales ("neutral.12")
// or literal colors. A component should never reach for a scale step directly.

const onSolid = (mode, name) =>
  HUES[name].onSolid === "white" ? "#ffffff" : scales[mode].neutral[mode === "light" ? 11 : 0];

function semantic(mode) {
  const L = mode === "light";
  const s = {
    // Surfaces, back to front. `sunken` is for code, terminals and logs — the agent's workspace.
    "bg-canvas": L ? "neutral.2" : "neutral.1",
    "bg-surface": L ? "#ffffff" : "neutral.2",
    "bg-raised": L ? "#ffffff" : "neutral.3",
    "bg-sunken": L ? "neutral.3" : "#0b0c10",
    "bg-overlay": L ? "#ffffff" : "neutral.3",
    "bg-hover": "neutral.4",
    "bg-active": "neutral.5",
    "bg-inverse": "neutral.12",
    "bg-scrim": L ? "#0f111766" : "#00000099",

    "border-subtle": "neutral.6",
    "border-default": "neutral.7",
    "border-strong": "neutral.8",

    "text-primary": "neutral.12",
    "text-secondary": "neutral.11",
    "text-tertiary": "neutral.9",
    "text-disabled": "neutral.8",
    "text-inverse": "neutral.1",
    "text-link": "iris.11",

    // Brand accent.
    "accent-solid": "iris.9",
    "accent-solid-hover": "iris.10",
    "accent-on-solid": onSolid(mode, "iris"),
    "accent-subtle": "iris.3",
    "accent-subtle-hover": "iris.4",
    "accent-border": "iris.7",
    "accent-text": "iris.11",
    // Focus ring is the solid, not step 8: it has to clear 3:1 against every surface.
    "focus-ring": "iris.9",
    selection: L ? "iris.5" : "iris.6",
  };

  // The agent, and the four statuses. Same shape for each, so a badge or banner is written once
  // and takes an intent.
  const intents = { agent: "cyan", success: "green", warning: "amber", danger: "red", info: "blue" };
  for (const [intent, hue] of Object.entries(intents)) {
    s[`${intent}-solid`] = `${hue}.9`;
    s[`${intent}-solid-hover`] = `${hue}.10`;
    s[`${intent}-on-solid`] = onSolid(mode, hue);
    s[`${intent}-subtle`] = `${hue}.3`;
    s[`${intent}-border`] = `${hue}.7`;
    s[`${intent}-text`] = `${hue}.11`;
  }

  // Windkeel's own vocabulary: an evidence package's verdict, and diffs. Verdict colors are for
  // icons, dots and labels on a surface, so they sit at the text step; a filled verdict badge
  // uses the matching intent's -solid pair instead.
  Object.assign(s, {
    "verdict-pass": "green.11",
    "verdict-fail": "red.11",
    "verdict-warn": "amber.11",
    "verdict-skipped": "neutral.11",
    "verdict-running": "cyan.11",

    "diff-add-bg": "green.3",
    "diff-add-emphasis": "green.5",
    "diff-add-text": "green.11",
    "diff-remove-bg": "red.3",
    "diff-remove-emphasis": "red.5",
    "diff-remove-text": "red.11",
  });
  return s;
}

const resolve = (mode, ref) => {
  const m = /^([a-z]+)\.(\d+)$/.exec(ref);
  return m ? scales[mode][m[1]][Number(m[2]) - 1] : ref;
};

// ---------------------------------------------------------------------------------------------
// Contrast checks. Pairs are [foreground token, background token, minimum ratio].

const CHECKS = [
  ["text-primary", "bg-canvas", 7],
  ["text-primary", "bg-surface", 7],
  ["text-primary", "bg-sunken", 7],
  ["text-secondary", "bg-canvas", 4.5],
  ["text-secondary", "bg-surface", 4.5],
  ["text-secondary", "bg-raised", 4.5],
  ["text-tertiary", "bg-surface", 3],
  ["text-link", "bg-surface", 4.5],
  ["text-inverse", "bg-inverse", 7],
  ["focus-ring", "bg-surface", 3],
  ["focus-ring", "bg-canvas", 3],
  ["accent-on-solid", "accent-solid", 4.5],
  ["accent-on-solid", "accent-solid-hover", 4.5],
  ["accent-text", "accent-subtle", 4.5],
  ...["agent", "success", "warning", "danger", "info"].flatMap((i) => [
    [`${i}-on-solid`, `${i}-solid`, 4.5],
    [`${i}-on-solid`, `${i}-solid-hover`, 4.5],
    [`${i}-text`, `${i}-subtle`, 4.5],
    [`${i}-text`, "bg-surface", 4.5],
  ]),
  ["diff-add-text", "diff-add-bg", 4.5],
  ["diff-remove-text", "diff-remove-bg", 4.5],
  ...["pass", "fail", "warn", "skipped", "running"].map((v) => [`verdict-${v}`, "bg-surface", 4.5]),
  // A solid has to stand off the page it sits on, not only carry its own text.
  ...["accent", "success", "danger", "info"].map((i) => [`${i}-solid`, "bg-canvas", 3]),
];

let failures = 0;
const report = [];
for (const mode of modes) {
  const sem = semantic(mode);
  for (const [fg, bg, min] of CHECKS) {
    const ratio = contrast(resolve(mode, sem[fg]), resolve(mode, sem[bg]));
    const ok = ratio >= min;
    if (!ok) failures++;
    report.push(`${ok ? "ok  " : "FAIL"} ${mode.padEnd(5)} ${fg} on ${bg}: ${ratio.toFixed(2)} (min ${min})`);
  }
}
console.log(report.join("\n"));
if (failures) {
  console.error(`\n${failures} contrast check(s) failed`);
  process.exit(1);
}
if (process.argv.includes("--check")) process.exit(0);

// ---------------------------------------------------------------------------------------------
// Output

const cssRef = (ref) => {
  const m = /^([a-z]+)\.(\d+)$/.exec(ref);
  return m ? `var(--${m[1]}-${m[2]})` : ref;
};
const block = (mode, indent) => {
  const pad = " ".repeat(indent);
  const prims = Object.entries(scales[mode]).flatMap(([n, steps]) =>
    steps.map((hex, i) => `${pad}--${n}-${i + 1}: ${hex};`),
  );
  const sem = Object.entries(semantic(mode)).map(([k, v]) => `${pad}--color-${k}: ${cssRef(v)};`);
  return [`${pad}color-scheme: ${mode};`, "", ...prims, "", ...sem].join("\n");
};

const css = `/*
 * Windkeel color tokens. GENERATED by design/scripts/generate-colors.mjs — edit that, not this.
 *
 * Components use the --color-* semantic tokens. The numbered scale steps underneath exist so
 * the semantic layer has something to point at; reaching for them directly is a smell.
 *
 * Theme follows the OS by default. Force one with <html data-theme="light|dark">.
 */

:root,
[data-theme="light"] {
${block("light", 2)}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${block("dark", 4)}
  }
}

[data-theme="dark"] {
${block("dark", 2)}
}
`;

// W3C Design Tokens (DTCG) format, for anything that is not CSS: Tailwind, Figma, native.
const json = { $description: "Windkeel color tokens. GENERATED by design/scripts/generate-colors.mjs." };
for (const mode of modes) {
  const prim = {};
  for (const [n, steps] of Object.entries(scales[mode])) {
    prim[n] = Object.fromEntries(steps.map((hex, i) => [i + 1, { $type: "color", $value: hex }]));
  }
  const sem = {};
  for (const [k, v] of Object.entries(semantic(mode))) {
    sem[k] = { $type: "color", $value: /^[a-z]+\.\d+$/.test(v) ? `{scale.${v}}` : v };
  }
  json[mode] = { scale: prim, color: sem };
}

mkdirSync(join(root, "tokens"), { recursive: true });
writeFileSync(join(root, "tokens/color.css"), css);
writeFileSync(join(root, "tokens/color.json"), JSON.stringify(json, null, 2) + "\n");
console.log("\nwrote design/tokens/color.css, design/tokens/color.json");
