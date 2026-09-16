# Data browser UI

**Status:** proposal, written 2026-09-16. Nothing here has shipped. This is an
audit of `browser/data-browser/src` plus a recommended order of work. Numbers
are measured against `develop` at `3b9f7e4`.

## The short version

The data browser does not have a *styling* problem, it has a *system* problem.
There is a theme object, but almost nothing is expressed in it, so 1155 styled
components each re-decide what "small text", "a gap", "a card" and "a shadow"
mean. The result reads as many small tasteful decisions rather than one product.

The fix is not a visual redesign on top of what exists. It is to make the
design decisions *sayable* — a real token layer — then delete the per-component
re-decisions. A restyle without that step produces the same drift again within
a year.

## What is actually there

| | |
|---|---|
| TS/TSX files in `src/` | 1068 |
| Lines | ~144k |
| Files importing `styled-components` | 415 |
| `styled.x` / `styled(...)` definitions | 1155 |
| `useState` / `useEffect` call sites | 874 / 598 |

Structure is `components/` (shared + feature), `views/` (per-class resource
renderers), `routes/` (pages), `chunks/` (lazy-loaded heavy features),
`helpers/`, `hooks/`, `actions/`.

### What is good and must survive a refactor

- **`src/actions/`**. One `ActionDefinition` per verb; the context menu, ⌘M
  menu, ⌘K palette, hotkeys, the shortcuts page and the AI tools are all
  *projections* of it (`planning/actions.md`, steps 1-4 shipped). This is the
  best structural idea in the package and the template for everything below:
  define once, project into every surface.
- **The class-dispatch model**. `ResourcePage` → per-class page,
  `ResourceCard` → per-class card, `ResourceInline` → per-class inline. Open,
  extensible, and plugins hook into it.
- **Container queries over media queries** where they are used (17 `@container`
  vs ~45 `@media`, most of the latter `print` or `prefers-*`). Components
  respond to *their* width, not the viewport's. That is the modern answer and
  it is already the house style; it is just not applied widely.
- **`floatingSurface` / `cardSurface`**. Two recent consolidations, each with a
  comment explaining which four divergent implementations it replaced. They are
  proof the team already knows the diagnosis. There need to be about fifteen
  more of these.

## The four real problems

### 1. There is no design system, only a theme object

`styling.tsx` exposes a `size()` scale, `radius`, three background steps, four
text steps, and three shadows. Measured adherence:

| Token | Used via theme | Written literally |
|---|---|---|
| Spacing | 263 `theme.size()` | 1577 raw `rem` + 639 `px` |
| Radius | 216 `theme.radius` | 88 literal |

And where there is no token at all, the drift is total:

- **56 distinct `font-size` values** across 334 declarations. Seven different
  ways to say "slightly smaller than body": `0.7 / 0.75 / 0.8 / 0.85 / 0.875 /
  0.9 / 0.95rem`, plus the `em` variants. Nobody chose seven. They accreted.
- **53 distinct `gap` values, 108 distinct `padding` values.**
- **39 distinct `box-shadow` values** against three theme shadows.
- **37 distinct durations**, against one `theme.animation.duration`.
- **50 hardcoded hex colours and 57 `rgba()` calls** outside `styling.tsx`.

This is the whole "doesn't feel modern" complaint, mechanically. Modern UI
reads as modern largely because its rhythm is regular: one type scale, one
spacing scale, one elevation ladder. Regularity is what 56 font sizes destroy.

### 2. The colour ramp is too short and anchored at pure black/white

`bg` is `#ffffff` / `#000000`, and every neutral is derived at runtime with
polished's `lighten`/`darken` off that anchor. Three background steps
(`bg`, `bg1`, `bg2`) and four text steps for an app this size. The
consequences:

- Components that need a step *between* `bg1` and `bg2` write `rgba()` or
  `darken()` inline. That is where the 107 stray colour literals come from.
- `lighten`/`darken` operate on HSL lightness, which is not perceptually
  uniform: the same delta is a big jump in blue and a small one in yellow, so
  the ramp is inconsistent across main-colour presets.
- `textLight2` is `#ccc` on white — roughly 1.6:1. The theme's own doc comment
  says "not accessible for some". It is used 8 times; those are 8 pieces of
  text people cannot read. `textLight` (314 uses) is fine at ~5.7:1.
- Pure-black dark mode with `lighten()` greys reads flat. Near-black with a
  slight hue is the current convention for a reason.

### 3. The theme is JavaScript, so it cannot be cheap or static

Every themed rule is a function interpolation resolved at render. Dark-mode and
main-colour changes are a React context change that invalidates the entire
tree. Runtime CSS-in-JS is also the piece most at odds with the rest of this
stack: React 19, the React Compiler, and a first-paint budget the repo already
profiles (`first-paint-timing.spec.ts`).

Colours, spacing, radii, type and durations should be CSS custom properties on
`:root`, flipped by a `data-theme` attribute. Theme switching then costs one
attribute write and zero re-renders, and the tokens become usable from plain
CSS, from the RTE, from the canvas, and from any future non-React surface.

### 4. Chrome density and page-weight

- `ResourcePage.tsx` eagerly imports ~20 page components, including
  `CanvasPage` (1929 lines) and the Meeting, AI-chat and Document views. Only
  `TablePage` and `DashboardPage` are `lazy()`. Opening a bookmark pays for the
  canvas editor.
- The navbar is a 2.2rem strip carrying back/forward, breadcrumb, context
  menu, search, tags, share, comments, AI, presence, follow status, meeting
  banner and content-language. It is already doing container-query juggling to
  fit. Some of this belongs in the resource page, not in global chrome.
- The sidebar's unlocked state is hover-to-reveal via opacity and a negative
  `left`. It is invisible but interactive-adjacent, and the fade fights the
  pointer.
- Typeface is Montserrat 700 + Open Sans, pulled from Google Fonts. It is a
  2015 pairing and it dates every screen it appears on more than any layout
  choice does.

## What to change

Ordered. Each phase is independently shippable and leaves the app working.
Phases 1-3 are the ones that matter; 4-5 are follow-on.

### Phase 1 — Tokens as CSS custom properties

Define the full token set once, in CSS, on `:root`, with a
`[data-theme='dark']` block. Keep `styled-components` and keep the theme object
as a thin facade that reads the variables, so nothing breaks on day one.

- **Colour**: author in OKLCH. Two ramps (neutral, accent) of 12 steps each,
  in the Radix-colors shape: app background, subtle background, component
  background / hover / active, borders subtle / normal / strong, solid /
  solid-hover, text low-contrast / high-contrast. Twelve steps sounds like a
  lot; it is exactly the number that stops people reaching for `rgba()`. Derive
  dark mode as its own ramp, not as `lighten()` of the light one.
- **Type**: 7 steps, one named role each (`--font-size-xs` … `--font-size-3xl`)
  and line-heights to match. Seven, so that "slightly smaller" has exactly one
  answer.
- **Space**: keep the existing `size()` ratio, expose it as
  `--space-1 … --space-15`.
- **Radius, elevation, duration, easing**: 3-4 steps each. One shadow ladder,
  not 39.
- Accessibility gate: every text-on-background pairing the ramp permits must
  clear 4.5:1. Delete `textLight2` rather than re-tune it.

Ship the ramps with a contrast unit test so the gate cannot silently regress.

### Phase 2 — Codemod the literals away

The token set is worthless until the 1155 styled components use it. This is
mechanical and should be done with a script plus review, not by hand and not
all at once:

1. `font-size` — 56 values collapse to 7. This is the single highest-visual-
   impact change in the whole plan and it is almost entirely find-and-replace.
2. `gap` / `padding` / `margin` — snap to the nearest space step.
3. `box-shadow` → elevation steps. `border-radius` → radius steps.
4. Durations → `--duration-*`.
5. Stray hex / `rgba()` → the nearest ramp step; anything that genuinely has no
   home is a missing token, so add it rather than keeping the literal.

Add an Oxlint rule (or a stylelint pass over the tagged templates) banning raw
colour literals, raw `font-size`, and raw durations in `src/`, so the drift
cannot come back. That rule is the actual deliverable of this phase; the
codemod just gets the tree to a state where it can be turned on.

### Phase 3 — Consolidate the surface vocabulary

Follow the `cardSurface` / `floatingSurface` precedent through the rest of the
UI. The target is a small named set, each defined once:

- `surface` (card / panel / row), with tone and elevation as *states*
- `field` (every input shares one height, radius, border, focus ring)
- `listRow` (sidebar items, search results, `ResourceLine`, dropdown items,
  file picker items — these are visually five things today and should be one)
- `chip` / `badge` (tags, counts, shortcuts, presence)
- `sectionHeader`

For each one, write the same kind of comment `cardSurface` has: what it
replaced and what may legitimately vary. That comment is what stops the next
person from forking it.

Simultaneously: reduce `Button`'s five boolean variant flags (`subtle`,
`alert`, `icon`, `clean`, `ghost`, silently ordered by a precedence chain in
`getButtonComp`) to one `variant` prop with a closed union. The current shape
lets callers pass three at once and get whichever the chain happens to pick.

### Phase 4 — Chrome

- Lazy-load every per-class page in `ResourcePage`'s `selectComponent`, not
  just the two heaviest. The dispatcher is already a switch returning a
  component; wrapping the rest in `lazy()` is contained, and the `Suspense`
  boundary already exists.
- Decide, per navbar affordance, whether it is *about the current resource*
  (tags, share, comments, presence) or *about the app* (search, back/forward,
  menu). Resource affordances belong on the resource page — next to the title,
  where the page-title component already puts "Add icon" and "Add cover" — and
  in ⌘M. That empties the navbar down to navigation and search, which is what
  a bar that thin can carry honestly.
- Replace hover-reveal sidebar with an explicit toggle plus the existing swipe
  gesture. Keep the resize handle.
- Move type to a variable font on a `system-ui` fallback stack — Inter for a
  neutral read, or a single variable family for both heading and body. Self-
  host it (the repo already has `vite-plugin-webfont-dl`) and drop one of the
  two families: two families at this density is unnecessary.

### Phase 5 — Zero-runtime CSS (optional, only after 1-3)

Once every rule is `var(--token)` rather than `p => p.theme...`, the majority
of styled components are static template literals, and the migration to CSS
Modules or vanilla-extract becomes mostly mechanical. That buys smaller
bundles, no runtime style injection, and first-paint headroom.

Do not start here. A styled-components → anything migration across 415 files,
*before* the tokens exist, is a year of churn that ends with the same 56 font
sizes in a different syntax.

## Non-goals

- A visual redesign as the first move. Phases 1-3 will already change how the
  app looks, because regular rhythm looks different from irregular rhythm.
  Judge the redesign question after them.
- Rewriting `views/` or the class-dispatch model. It works.
- Touching `src/actions/`, except to project more surfaces from it.
- A component library dependency. The Radix primitives already in use (popover,
  tabs, scroll-area) cover the hard accessibility cases; the rest is a token
  problem, not a component problem.

## Decisions to make before starting

1. **Radix-colors-shaped 12-step ramps, or a shorter custom ramp?** The
   recommendation is 12 steps in the Radix shape, because the step *roles* are
   what make "which grey" answerable. Adopting the shape does not require the
   dependency.
2. **Does the token layer ship to `@tomic/react` consumers?** If the tokens are
   CSS variables, embedders can theme the browser without a build step. That
   argues for putting them in a small standalone CSS file rather than inside
   `styling.tsx`.
3. **How much codemod risk is acceptable per PR?** Suggested: one property per
   PR (all `font-size`, then all `gap`), with the e2e suite and the visual
   snapshots in `e2e.spec.ts-snapshots` as the gate.
