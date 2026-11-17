Windkeel is a tool for watching an agent change code and checking that change independently. People read it for long stretches: transcripts, logs, diffs, evidence. So the interface is quiet and dense. Color is spent only where it carries meaning. Every surface should make one question easy to answer: *what is the agent doing, and did it work?*

## Voice and content

- Write from the reader's side of the screen. Name things by what people see: *run*, *stage*, *evidence*, *pull request*. Don't use internal names like *workflow*, *handler* or *adapter*.
- Sentence case everywhere: buttons, titles, tabs. *Open pull request*, not *Open Pull Request*.
- Buttons are verbs that say what happens: *Stop run*, *Retry stage*, *Approve*. Never *OK* or *Submit*.
- State facts plainly, in past tense for what happened: *Pull request #276 opened*. No *Success!*, no exclamation marks, no apologies.
- An error says what went wrong and what to do: *Branch names can't contain spaces. Try fix-late-merge.*
- Verdicts are fixed words from the evidence package: **pass**, **warn**, **fail** — and, for a stage, **skipped**, and **running** while it has none yet. Use them exactly. Never soften them (*mostly passed*).
- The agent is *Windkeel*. It speaks in first person, briefly, and says what it's about to do before it does it. It never uses emoji.
- Show real values, not paraphrases: `src/factory/run-service.ts`, `npm test`, `sha256:9c1e…a07b`. People copy them.

## Color

Each color family has one job, and the jobs never overlap.

- **Graphite** (`neutral-*`) is the shell. Paint surfaces with `color-bg-canvas` (the app background), `color-bg-surface` (panels, cards, the transcript) and `color-bg-sunken` (code, terminals, logs). Separate regions with `color-border-subtle`.
- **Iris** (`color-accent-*`) is *you*: anything you can act on. Primary buttons are `color-accent-solid` with `color-accent-on-solid` text. The selected nav row and the selected tab are neutral (`color-bg-active`, `color-text-primary`): they say where you are, which is not an action. Links use `color-text-link`. Never use iris to show a result.
- **Cyan** (`color-agent-*`) is *the agent*: anything it is doing right now, such as the running step, the thinking dots, its avatar and the running verdict. When nothing on screen is cyan, the agent is idle. Never use cyan for anything else.
- **Green, amber, red, blue** (`color-success-*`, `color-warning-*`, `color-danger-*`, `color-info-*`) are status only. The verdict tokens map onto them: `color-verdict-pass`, `-warn`, `-fail`. Don't use them decoratively.
- Text: `color-text-primary` for body text and titles, `color-text-secondary` for supporting text, `color-text-tertiary` only for timestamps, meta and placeholders (never full sentences).
- Components use `color-*` tokens only. If you find yourself reaching for a scale step like `red-11`, a semantic token is missing: add one rather than bypassing the layer.
- Both themes are first-class. The theme follows the OS setting, and `data-theme="light|dark"` on `<html>` forces one.

## Typography

- Set the interface in IBM Plex Sans and all code, paths, commands and hashes in IBM Plex Mono. The two are drawn as one family, so mono inside a sentence sits level with the sans around it.
- The base size is 14px (`text-body`). Use `text-small` (13px) for controls and list rows, `text-caption` (12px) for meta, and `text-code-small` (12px mono) for terminal and diff lines.
- Headings go up in few, wide steps: `text-subheading` 15px, `text-heading` 18px, `text-title` 24px. `text-display` (32px) is for empty states only.
- `text-overline` (11px uppercase, 0.06em letter spacing) labels groups in the sidebar and panels. Nothing else is uppercase.
- Use weights 400, 500 and 600 only. Emphasize with 500 or 600, never with italics or color.
- Use `font-variant-numeric: tabular-nums` wherever digits line up: durations, counts, line numbers.

## Spacing and layout

- Everything sits on a 4px grid (`space-1` is 4px). Put `space-2` between sibling controls, `space-4` inside cards and panels and between messages, and `space-8` between page sections.
- The app shell has three columns: the run list (`sidebar-width`, 248px), the transcript (capped at `content-max`, 760px), and the evidence panel (`panel-width`, 400px). Separate the columns with `color-border-subtle` borders, not cards or shadows.
- Controls are `control-md` (32px) tall by default, `control-sm` (28px) in toolbars and dense rows, and `control-lg` (40px) only for the one call to action on an empty state or dialog.

## Shape and elevation

- Radius grows with size: `radius-xs` for inline code and keys, `radius-md` for buttons, inputs and steps, `radius-lg` for cards, terminals and the composer, `radius-xl` for dialogs and toasts, and `radius-full` for badges, avatars and switches.
- Borders separate things; shadows lift them. Resting cards get no shadow. `shadow-xs` goes under buttons and inputs, `shadow-md` under menus and toasts, `shadow-lg` under dialogs. Dark-theme shadows include a faint light edge, because a dark shadow alone disappears on a dark page.

## States

- Focus: every focusable element shows a 2px `color-focus-ring` outline, offset 2px. It clears 3:1 against every surface in both themes. Inputs show the ring as their border plus a 3px `color-accent-subtle` halo.
- Hover: neutral controls move to `color-bg-hover`. Solids move to their `-solid-hover`.
- Disabled: 50% opacity with a not-allowed cursor. Don't disable the composer while the agent works.
- Loading: a `Spinner` next to a label that says what is loading. The agent's thinking uses the cyan dots, never the spinner.

## Motion

- `duration-fast` (120ms) for hover and press, `duration-base` (200ms) for expanding and toggling, `duration-slow` (320ms) for dialogs and toasts entering. Use `ease-standard` for most transitions and `ease-out` for things arriving.
- Motion means something is happening. The only looping animations are the running pulse, the spinner and the thinking dots. All motion stops under `prefers-reduced-motion`.

## Iconography

- Use stroked line icons on a 24px grid, drawn at `icon-md` (16px) with a 1.75 stroke, round caps and joins, and `currentColor`. The icons in these previews are simple inline SVGs in that style. Lucide matches it if a full set is needed.
- Add the `oq-icon` class to every icon. An icon either sits next to a label or has an `aria-label`. Icon-only buttons are square `oq-button--icon`.
- Tools have fixed icons in agent steps: a file for *read*, a pencil for *edit*, a terminal prompt for *run*, a magnifier for *search*.

## Agent patterns

- A run's transcript is a column of Messages. The person's turns sit on `color-bg-sunken` panels. The agent's turns are full-width documents, not chat bubbles.
- Everything the agent does is an AgentStep with the real target shown. Only the step happening now is cyan. A step that needs your approval has a dashed amber border and stays put until you answer.
- Command output goes in a Terminal and file changes in a DiffView, each inside the step that produced it.
- The evidence panel (EvidenceList) always lists every stage, including skipped ones, and shows the package's own verdict. The UI never computes the verdict itself.

## Accessibility

- Contrast is enforced by the generator: body text is at least 7:1 on every surface, secondary and status text at least 4.5:1, and text on every solid (and its hover) at least 4.5:1, in both themes.
- Green and red share a lightness, so color is never the only signal. Verdicts always carry their word. The pass mark is a circle, the fail mark a square, and skipped is hollow.
- Use native elements first: `<button>`, `<dialog>`, `<details>`. Add roles only where HTML has none (`role="switch"`, `role="tablist"`).
