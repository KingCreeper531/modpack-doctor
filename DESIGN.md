# Modpack Doctor — Design Contract

Status: **FROZEN (M1)**. Changes need a proposal and owner approval. Agents may propose, never edit.

## 1. Direction: "diagnostic instrument"

This app is a piece of test equipment crossed with a field-repair manual. It shows a lot of
information at once and stays calm about it. Every pixel is either a reading, a control, or a rule
separating readings. Reference points: an oscilloscope front panel, an aircraft maintenance log, a
parts catalogue. Not a SaaS dashboard.

The look comes from these choices:
- **Ruled, not floating.** Content sits in panels separated by 1px hairlines and shares edges with
  its neighbours. Nothing hovers on a shadow.
- **Mono for facts, condensed sans for words.** Anything you could copy into a bug report (a version,
  hash, path, mod id or log line) is set in IBM Plex Mono. Labels and prose use IBM Plex Sans Condensed.
- **One signal colour.** Amber means "look here": focus, selection and warnings. Red oxide means
  broken and moss means fine. Nothing else is coloured.
- **Density with rhythm.** Rows are 24px or 32px tall on a strict 8px grid. Section labels are small
  letterspaced caps that read like silkscreened panel legends.

## 2. Colour tokens

Colour carries meaning only. Never use a token for decoration. Tailwind's default palette is
**disabled**: only these tokens exist.

### Dark (default)

| Token | Hex | Use |
|---|---|---|
| `bg` | `#14130F` | window base |
| `panel` | `#1C1A16` | panel surface |
| `raised` | `#24221D` | row hover, input wells, inspector header |
| `line` | `#2E2B25` | hairline borders between panels and rows |
| `line-strong` | `#45413A` | control outlines, table header rule |
| `fg` | `#E9E4D8` | primary text |
| `fg-dim` | `#ADA697` | secondary text, column values |
| `fg-faint` | `#958F81` | section labels, line numbers, metadata |
| `signal` | `#F2A93B` | phosphor amber: focus ring, selection, warning severity |
| `signal-ink` | `#14130F` | text placed on a `signal` fill |
| `err` | `#D2553A` | red oxide: error rails, tiles and fills (non-text) |
| `err-text` | `#E0664A` | error text (lifted for AA on `raised`) |
| `ok` | `#7FA36B` | muted moss: OK tiles, OK text |
| `info` | `#8E9BA6` | desaturated slate: info severity |
| `tile-empty` | `#2A2721` | unscanned tile |
| `tile-off` | `#3A372F` | disabled-mod tile (also uses a hatch pattern so it doesn't rely on colour) |
| `hl-line` | `#F2A93B1F` | amber wash behind a culprit log line (alpha 12%) |

### Light (warm paper)

| Token | Hex | Use |
|---|---|---|
| `bg` | `#F4F0E6` | paper |
| `panel` | `#ECE7DA` | |
| `raised` | `#E3DDCE` | |
| `line` | `#D6CFBE` | |
| `line-strong` | `#B9B09C` | |
| `fg` | `#1E1C18` | ink |
| `fg-dim` | `#4F4A42` | |
| `fg-faint` | `#645E54` | |
| `signal` | `#8A5200` | amber darkened for contrast, used for text, rings and rails |
| `signal-fill` | `#B8741A` | warning tiles and fills (non-text) |
| `signal-ink` | `#F4F0E6` | text placed on a `signal` fill |
| `err` | `#B8452B` | fills and rails |
| `err-text` | `#A8361E` | |
| `ok` | `#45663A` | text; tiles use `ok-fill` `#5E8549` |
| `info` | `#4A5866` | |
| `tile-empty` | `#DDD6C6` | |
| `tile-off` | `#C9C1AE` | with hatch |
| `hl-line` | `#B8741A26` | |

In dark mode `signal-fill` = `signal` and `ok-fill` = `ok`, so every component can use the same
token names in both themes.

### Measured contrast (WCAG 2.1; text needs ≥ 4.5, UI graphics ≥ 3.0)

| Pair | Dark (bg / panel / raised) | Light (bg / panel / raised) |
|---|---|---|
| `fg` | 14.65 / 13.70 / 12.53 | 14.95 / 13.78 / 12.56 |
| `fg-dim` | 7.68 / 7.18 / 6.57 | 7.72 / 7.11 / 6.48 |
| `fg-faint` | 5.77 / 5.40 / 4.94 | 5.64 / 5.20 / 4.74 |
| `signal` (text) | 9.31 / 8.70 / 7.96 | 5.61 / 5.17 / 4.71 |
| `err-text` | 5.46 / 5.10 / 4.67 | 5.75 / 5.30 / 4.83 |
| `ok` (text) | 6.51 / 6.08 / 5.56 | 5.74 / 5.29 / 4.82 |
| `info` | 6.54 / 6.11 / 5.59 | 6.41 / 5.91 / 5.38 |
| `err` fill (graphic) | 4.51 / 4.22 / 3.86 | 4.70 on bg |
| `signal-ink` on `signal` | 9.31 | 5.61 |

Rules:
- Never put `err` (the fill token) behind or under text. Use `err-text` for error text.
- `signal-ink` goes only on `signal` (9.31 / 5.61). Never on `signal-fill`: in light mode that
  measures 3.32 and fails.
- **Culprit log lines** (`hl-line` wash) reduce contrast: `fg-faint` falls to 4.30 (dark, over
  panel) and `err-text` to 4.07. On a highlighted row the gutter number uses `fg-dim` and the
  text uses `fg`. `fg-faint` and `err-text` never sit on `hl-line`.
- **Tiles** are non-text graphics and need ≥ 3:1 against `panel` for their *defining mark*.
  `tile-empty` and `tile-off` fills alone are ~1.2–1.5, so unscanned tiles are drawn as a hollow
  1px `fg-faint` outline (5.40), and disabled tiles carry a `fg-faint` hatch (see §6.1).
- `line` and `line-strong` are separators, not boundaries a control depends on. Interactive controls
  always have a visible label as well.

## 3. Typography

Fonts are bundled locally with `@fontsource` (no CDN). **Inter, Geist and system-ui must never be the
primary font.** The fallback stack exists only for glyphs Plex lacks.

- UI and headings: `"IBM Plex Sans Condensed", "Arial Narrow", sans-serif`, weights 400 / 500 / 600
- Technical: `"IBM Plex Mono", ui-monospace, monospace`, weights 400 / 500
- Tabular numerals (`font-variant-numeric: tabular-nums`) everywhere numbers line up: tables, the
  summary strip, line numbers, sizes, timings.

| Token | Size / line-height | Use |
|---|---|---|
| `t-label` | 11px / 16px, 500, uppercase, `letter-spacing: 0.08em` | section legends (`MODS`, `FINDINGS`) |
| `t-small` | 12px / 16px | metadata, chips, table secondary |
| `t-body` | 13px / 20px | default UI text, table rows |
| `t-mono` | 12px / 16px mono, tabular | versions, ids, hashes, paths |
| `t-log` | 12px / 18px mono | log viewer lines |
| `t-title` | 15px / 24px, 600 | panel titles, inspector heading |
| `t-head` | 18px / 24px, 600 | the single page heading in the workspace (instance name) |

Nothing is larger than 18px. There are no hero headings.

## 4. Space, shape, structure

- **8px grid.** Tailwind's spacing unit is 4px (`--spacing: 4px`). **Layout** (panel padding,
  gaps between regions, row heights, offsets) uses even steps only: `2`=8px, `4`=16px, `6`=24px,
  `8`=32px. The single 4px half-step (`1`) is allowed **only inside a component**, for icon-to-text
  gaps and chip padding, where optical alignment needs it. No other steps exist; the design-lint
  test rejects 12px, 20px and fractional steps. Row heights are 24px (dense) and 32px (default).
- **Radius:** `r-1` = 2px (chips, tiles, inputs), `r-2` = 4px (buttons, menus). Nothing larger.
  `rounded-2xl` and its relatives don't exist in the config.
- **Borders, not shadows.** Use 1px `line` borders. The only shadow allowed is the one under native
  menus and popovers, `0 0 0 1px line-strong` plus `0 4px 12px rgb(0 0 0 / .35)`, and only for
  elements that truly overlay other content.
- **Panels** are full-bleed regions divided by hairlines. Each has an 11px uppercase legend in a 32px
  header row with right-aligned meta (counts, timings) in `t-small`/mono.
- **Lists are tables or ruled rows**, never grids of identical cards.

## 5. Layout

```
┌ rail 240px ┬──────────────── workspace (flex) ──────────────────┬ inspector 360px (resizable 280–640) ┐
│ INSTANCES  │ <instance name>                         t-head      │ MOD / FINDING                        │
│ ▸ row      │ 1.20.1 · Forge 47.3.0 · 214 mods · 3 errors · …     │                                      │
│ ▸ row      ├─ SCAN ────────────────────────────── 214/214 2.1s ─┤                                      │
│            │ ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪ (tile grid) │                                      │
│            ├─ FINDINGS ───────────────────── 3 E · 5 W · 2 I ──┤                                      │
│ + Add      │ ▌E-SPLIT-PKG  Two jars ship package x.y  a.jar b… │                                      │
│  folder    │ ▌W-…                                               │                                      │
│            ├─ MODS ─────────────────────────────── sortable ───┤                                      │
└────────────┴────────────────────────────────────────────────────┴──────────────────────────────────────┘
```

- **Instance rail row (48px, two lines):** the name (`t-body` 500) and, below it, a mono line with
  the launcher abbreviation (`MR`, `PR`, `MMC`, `CF`, `VAN`, `DIR`, `PACK`), MC version, loader glyph,
  loader version and mod count. A 4px status pip on the right edge shows the last scan
  (`ok` / `signal` / `err` / `tile-empty`). The selected row gets a 2px `signal` left rule plus a
  `raised` background.
- **Summary strip:** one 32px line of mono segments separated by ` · `. Error and warning counts are
  coloured by severity. "scanned 2.1s ago" is `fg-faint`. No stat cards.
- **Inspector:** a resizable split. The drag handle is a 1px line that thickens to 2px `signal` on
  hover or drag. The width persists in settings.

## 6. Signature components

### 6.1 Scan grid (hero)
- Rendered on canvas. One tile per top-level jar: **12×12px with a 2px gap** (14px pitch), drawn
  inside a ruled panel, with each row filling the available width.
- Tile states:

  | State | Colour | Shape |
  |---|---|---|
  | unscanned | `tile-empty` fill + 1px `fg-faint` outline | hollow-looking square |
  | ok | `ok-fill` | filled square |
  | warning | `signal-fill` | filled square |
  | error | `err` | filled square **plus a 2px notch cut out of its top-right corner** |
  | disabled | `tile-off` fill + 1px `fg-faint` 45° hatch | hatched square |

  Shape differs as well as colour, so colour-blind users and greyscale prints still work.
- Fill-in: a tile changes state when its `ScanProgress` event arrives, with a 140ms ease-out
  cross-fade of fill colour only. No scale or bounce.
- Hover: a 1px `fg` outline around the tile, and a mono tooltip `modid  1.4.2  ·  WARN 2`.
  Click: selects the mod (inspector) and scrolls the mod table to it. Keyboard: arrow keys move a
  focus tile (2px `signal` outline).
- Performance: one canvas draw per animation frame at most. Hit-testing is arithmetic
  (`col = x / pitch`). It must stay at 60fps with 1,000 tiles.

### 6.2 Triage list
- Each row is 32px collapsed:
  `[4px severity rail][code mono 12px, fixed 144px][one-line diagnosis t-body][culprit jar chips, right-aligned]`.
- Severity rail colours: `err` / `signal` / `info`. The code text uses the matching text token.
- Expanded (Enter or click; height animates 160ms ease-out): an explanation paragraph (max 72ch),
  an evidence block (§6.3 or a metadata excerpt with highlighted lines), then the fix buttons row.
- The focused row (J/K) gets a `raised` background plus a 1px `signal` outline inset. A selected row
  shows in the inspector.

### 6.3 Evidence / log viewer
- Mono `t-log`. The gutter holds right-aligned line numbers in `fg-faint` with a 1px `line` rule.
- A culprit line gets the `hl-line` background and a 2px `signal` left marker. Context lines are
  `fg-dim`.
- Stack frames that map to a jar render the jar as a **chip**: 2px radius, 1px `line-strong` border,
  mono 11px, clickable (it selects the mod).
- Elided ranges show as a single `⋯ 1,204 lines` divider row.

### 6.4 Work order
- A panel replaces the workspace bottom section (not a modal). Its title is `WORK ORDER #<id>`.
- It's a numbered checklist, one row per file operation, in mono:
  `01  rename   mods/sodium-0.5.8.jar → mods/sodium-0.5.8.jar.disabled`
  `02  download sodium 0.5.11 (312 KB) from cdn.modrinth.com → mods/sodium-0.5.11.jar`
- The status column shows `pending` (`fg-faint`), `running` (`signal` with a 6px pulsing bar, or a
  static bar under reduced motion), `done` (`ok`), `failed` (`err-text`, with the message inline) or
  `skipped`.
- A footer lists the backup location (mono path) plus **Execute** (primary ink button, §6.5) and
  **Cancel**. There's never a generic "Are you sure?".
- **Keyboard:** Esc cancels. Enter executes **only** when `kind = undo` and the order is a single
  `rename` op (e.g. undoing a disable). The Execute label then shows a `↵` hint in `t-mono`.
  Every other order, including any download or move, needs a click or Tab + Space on Execute.

### 6.5 Controls
- **Button:** 24px or 32px tall, `r-2`, 1px `line-strong` border, `panel` background. Hover → `raised`.
  The primary variant is an **ink button**: `fg` fill with `bg` text (14.65 / 14.95). It is not
  amber, because amber carries meaning (focus, selection, warning), not emphasis. The danger
  variant has an `err` border and an `err-text` label. The focus ring is a 2px `signal` outline offset **2px** on every
  focusable element. The offset is required: ring vs surface measures 9.31 / 8.70 / 7.96 (dark bg
  / panel / raised) and 5.61 / 5.17 / 4.71 (light), but ring vs the ink button fill is only 1.57
  (dark) / 2.66 (light). The 2px surface gap keeps the indicator ≥ 3:1 against everything it
  touches (WCAG 2.4.13). Inside dense rows, where an outline would overlap neighbours, use an
  inset 1px `signal` outline plus the `raised` background instead.
- **Toggle (mod enable):** a 28×14 track with a square 10px thumb. On = `ok-fill` track, off =
  `tile-off`. The `aria-pressed` label changes too.
- **Chip:** mono 11px, 16px tall, `r-1`.
- **Table:** a 24px header row in `t-label` with `line-strong` under it. Body rows are 24px,
  separated by hairlines. The sorted column shows a `▲`/`▼` glyph in `fg-faint`. Numbers are
  right-aligned and tabular.
- **Tooltip:** `raised` background, 1px `line-strong` border, mono 11px, no arrow, 0ms show delay
  on canvas and 400ms elsewhere.
- **Inputs:** a `raised` well, 1px `line-strong`, `r-1`, 24px tall.
- **Overlays** (menus, palette, tooltips) are the only elements with a shadow, the
  `shadow-overlay` token. Its alpha is .35 in dark and .18 in light (`--c-overlay-shadow`).

### 6.6 Mod table
Columns, left to right:

| Column | Width | Content |
|---|---|---|
| status rail | 4px | severity colour of the worst finding, or none |
| icon | 24px | 16px Modrinth icon, or the loader glyph when there is none |
| name | flex | `t-body`, with the mod id beneath in `t-mono` `fg-faint` |
| version | 120px | `t-mono` |
| loader | 80px | glyph plus abbreviation |
| Modrinth | 112px | `matched` (`ok`), `update 0.5.11` (`signal`, followed by `beta` for a non-release), `not on Modrinth` (`fg-faint`), `—` unknown/offline |
| status | 96px | finding count by severity |
| enabled | 48px | toggle |

Rows are 24px. Headers sort with a click, and the sort state persists per instance. Nested jars
expand under their parent with a 16px indent and a `└` glyph in `fg-faint`.

### 6.7 Command palette (Ctrl/Cmd+K)
- A 560px-wide overlay anchored 64px below the top of the window, never centred vertically.
  `panel` background, `shadow-overlay`, `r-2`.
- The input row is 32px, with a `t-mono` placeholder `instance, mod id, or action…`.
- Results are 24px rows grouped under `t-label` headings (`INSTANCES`, `MODS`, `ACTIONS`). The
  active row gets `raised` plus a 2px `signal` left rule, and the right-aligned shortcut shows in
  `t-mono` `fg-faint`.
- No fuzzy-match highlight colours. Matched characters are `fg`, the rest `fg-dim`.

### 6.8 About dialog
- A panel overlay laid out like a data plate. Under the legend `ABOUT`, a two-column table of
  version, build commit, Tauri version, data directory, cache directory and licence.
- A disclaimer paragraph in `t-small` `fg-dim`: "Modpack Doctor is not affiliated with or
  endorsed by Modrinth, Mojang, Microsoft, Forge, NeoForge, Fabric, or Quilt." No third-party
  logos.

## 7. Icons and glyphs
- **Phosphor Icons, regular weight, 16px**, colour `currentColor`. Use them sparingly: rail actions,
  table column affordances and menu items. **No Lucide, no emoji, no sparkles.**
- Loader glyphs are original 12/16px SVGs drawn on a 16-unit grid with 1.5px strokes. They must not
  resemble the official logos:
  - Forge: an anvil-face trapezoid with a horizontal bar
  - NeoForge: the same trapezoid split by a diagonal
  - Fabric: a three-thread weave (three parallel diagonals crossed by one)
  - Quilt: a 2×2 patch grid with one cell offset
  - Legacy Forge: the Forge glyph, dashed
  - Unknown: a hollow square with a `?` in mono

## 8. Motion
- Duration is 120–180ms, `cubic-bezier(0.2, 0, 0, 1)` (ease-out), and only to show a state change:
  tile fill, row expand/collapse, panel resize, the status bar during a running op.
- No page transitions, no entrance or fade-in animations, no springs, no bounce, no staggered lists.
- `@media (prefers-reduced-motion: reduce)` sets durations to 0ms and replaces the running pulse
  with a static bar.

## 9. Theming mechanics
- Tokens are CSS custom properties on `:root[data-theme="dark"]` and `:root[data-theme="light"]`.
  The UI always writes a **resolved** theme to `data-theme`. For the `system` preference it reads
  `matchMedia('(prefers-color-scheme: dark)')` and listens for changes. There is no
  `data-theme="system"` rule in CSS. Tailwind's colours map only to these vars.
- On every resolved-theme change the UI calls `set_window_theme`, so the Windows title bar (through
  DWM) matches: `bg` caption, `fg` caption text, `line` border.

## 10. Empty, loading, and error states
- **No instances found:** a ruled table of every launcher the app checked, its OS path (mono), and
  the result (`not installed` / `0 instances` / `permission denied`), plus an **Add folder** button.
  No illustration, no "Get started".
- **Scanning:** the grid fills in live. The summary strip shows `scanning 132/214`. The UI never
  blocks.
- **Offline / Modrinth error:** a one-line notice in the summary strip, `Modrinth unreachable —
  static checks only`, in `fg-dim` with an `info` pip. Rate limited: `Modrinth rate limit —
  retrying in 42 s` (one automatic retry). Switched off by the user: a quiet `Modrinth off` summary
  segment in `fg-faint`, no pip.
- **Modrinth settings** ("Look up mods online", "Suggest beta updates") sit in the rail footer
  above THEME.
- **Errors from Rust** (`AppError`) render as an inline row with the `err` rail, the kind code in
  mono and the message, never as a toast stack.

## 11. Banned (verbatim from the brief; the reviewer checks each one)
- Purple/blue/indigo gradients, glassmorphism, frosted blur, glowing borders, neon
- Inter, Geist, or system-ui as the primary font
- The stock shadcn/ui look: big `rounded-2xl` cards everywhere, soft drop shadows, everything floating on gray
- Centered hero layouts, oversized empty headings, "Get started" splash screens
- Emoji as icons, sparkle ✨ motifs, gradient text
- Lucide icons (the default everyone uses)
- Every list rendered as a grid of identical cards
- Bouncy spring animations, fade-in-on-everything

These are also banned in this project:
- `linear-gradient`/`radial-gradient` anywhere
- `backdrop-filter`
- any `box-shadow` outside §4's overlay rule
- border radius > 4px
- centred page layouts

## 12. Review checklist (run at 1280×800 and 1920×1080, in both themes)
1. Only token colours appear (grep the CSS for raw hex outside `tokens.css`).
2. No text below 4.5:1 contrast (spot-check with devtools).
3. Fonts render as Plex. Computed `font-family` is never Inter, Geist or system-ui.
4. Every number column is tabular and right-aligned.
5. Nothing has a radius > 4px, a shadow outside overlays, or a gradient.
6. Each §11 item has been checked visually and by grep.
7. The scan grid stays smooth with 600+ tiles (performance panel: no long frames).
8. With reduced motion on, nothing animates.
