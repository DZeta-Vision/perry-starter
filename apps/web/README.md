# web

The front-end application. UI is built on a single normative design-token
source, the Inter Variable webfont, and the shadcn component baseline inherited
as-is and re-skinned through tokens only.

## Design system

- **Single normative token source:** `src/index.css` holds the full light
  (`:root`) and dark (`.dark`) token sets, the `@theme inline` font/radius
  mapping, and the load-bearing `@import "shadcn/tailwind.css"`. No other file
  under `src/` may declare a competing `:root`/`.dark` token block — `index.css`
  is the only place tokens are defined.
- **Font seam:** the `--font-sans` token names `"Inter Variable"`, and the
  Inter Variable webfont is loaded as a first-class asset (`@fontsource-variable/inter`
  imported at the client entry, `src/router.tsx`). Swapping `--font-sans` to a
  different family means swapping the loaded asset too — the token must never
  point at a family no asset provides, or the surface silently falls back to
  system sans.
- **Components inherited as-is:** the `src/components/ui/*` set is re-skinned via
  semantic token utilities only (`bg-primary`, `text-primary-foreground`,
  `bg-popover`, `border-input`, …). The only brand-touched surfaces are the
  Button primary variant and the sidebar active item. Modal depth is capped at
  one level — a dialog never opens over another dialog.

## Re-skin

To re-brand the template, change the teal-derived tokens in `src/index.css`.
There are **four items** (≈9 token values across both themes):

1. **`--primary`** — the brand fill, in both `:root` and `.dark`.
2. **`--primary-foreground`** — text on the brand fill. The dark value is
   teal-tinted, so re-derive it for a new hue.
3. **`--chart-1`, `--chart-2`, `--chart-3`, `--chart-4`, `--chart-5`** — the
   chart ramp, in both themes (10 values). No chart components ship in v1, so
   these are documentation-only: regenerate the ramp from the new `--primary`
   when charts are introduced. They carry no text, so they have no contrast pair.
4. **`--sidebar-primary` + `--sidebar-primary-foreground`** — the active
   navigation item and its text, in both themes.

A recommended (post-v1) derivation expresses the derived tokens relative to the
brand fill, e.g. `oklch(… from var(--primary) …)`, so a single `--primary` edit
propagates. This is not wired in v1; edit each token explicitly for now.

### Contrast obligation

Any `--primary` (or sidebar token) change is re-measured automatically: the
WCAG-AA contrast gate (`scripts/contrast-gate.mjs`) runs BLOCKING on every PR,
so a re-skin that drops a pair below its floor fails CI. Run it locally with
`bun run gate:contrast`.

Measured ratios for the shipped teal tokens (must stay ≥ floor):

| Pair | Floor | Light | Dark |
| - | - | - | - |
| `--primary` ↔ `--primary-foreground` | 4.5:1 | 4.89:1 | 5.68:1 |
| `--primary`-as-link ↔ `--background` | 4.5:1 | 5.16:1 | 7.83:1 |
| `--ring` ↔ `--background` | 3:1 | 3.36:1 | 4.18:1 |
| `--sidebar-primary` ↔ `--sidebar` | 4.5:1 | 4.94:1 | 9.47:1 |
| `--sidebar-primary` ↔ `--sidebar-primary-foreground` | 4.5:1 | 4.89:1 | 7.59:1 |

If a re-skin pushes any pair below its floor, darken the offending token until
the gate passes again, then update this table.
