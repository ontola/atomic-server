# Atomic brand assets

Single source of truth for every Atomic icon and favicon, across all apps and
repositories.

> **Licensing:** the files in this directory are **not** MIT licensed, unlike the
> rest of this repository. See [`LICENSE`](./LICENSE) and
> [`../TRADEMARKS.md`](../TRADEMARKS.md). Reserving the marks is what lets the
> code stay permissively licensed.

## The marks

| File | Used for |
| --- | --- |
| `src/atomic-mark.svg` | Atomic Server — everything: server, data-browser, desktop, iOS, docs, portal, marketing site |
| `src/atomic-mark-mono.svg` | single-ink contexts (Safari pinned tab). Ring and orb are separated by a real gap instead of the colour mark's white keyline, which carries no information once flattened |
| `src/canvas-mark.svg` | Atomic Canvas — the open sweep. Same orb, same gradient, same family |

Colours: the orb ramps `#01ECFF` (right) → `#2210FF` (left). The ring is black.
That gradient is the one brand constant — every mark shares it.

## Regenerating

```sh
node brand/generate.mjs
git diff                  # empty = nothing drifted
```

Requires `rsvg-convert` and ImageMagick 7 (`brew install librsvg imagemagick`).
The `.icns` additionally needs macOS `iconutil`; on other platforms that one
target is skipped with a warning.

Derived files **are committed**, so app builds and offline checkouts need no
image tooling — only regenerating does.

### Why there is no `--check` mode, and no CI job

Rendering is deterministic: running the generator twice produces byte-identical
output. So `git diff` after a run already answers "has anything drifted?"
exactly, reusing the byte-differ we already have.

A CI version cannot work that way. Runners have different librsvg and
ImageMagick versions, which do not encode identical bytes, so it would have to
compare images *perceptually* — which in practice meant a similarity threshold,
an ImageMagick 6-vs-7 shim, a byte-compare fallback for `.icns` (no decode
delegate), a frame-index workaround for `.ico` (comparing a container against
itself reports differences), and a duplicated path filter in the workflow.
That was ~126 lines and five separate workarounds guarding against a
cosmetically stale icon. Not worth it. Deleted deliberately — please don't
re-add it without a better reason than symmetry.

## Editing rules

1. Change `src/*.svg`, never a generated file. Every icon in every app is
   overwritten from these three.
2. Re-run the generator and commit the result in the same change.
3. Adding a surface means adding an entry to `TARGETS` in `generate.mjs`, not
   copying a PNG by hand.

### One trap worth knowing

`atomic-mark.svg` re-bases the original artwork onto a clean `0 0 100 100`
viewBox with a `translate(-108,-28)` on the group. The gradient uses
`gradientUnits="userSpaceOnUse"`, which resolves in the *translated* space —
so its coordinates deliberately stay in the old range (`x1="167"`). Re-basing
them to match the viewBox silently flattens the orb to solid cyan, with no
error. If the orb ever loses its gradient, look here first.

## Coverage

Generated into, across three repositories:

- `atomic-server` — data-browser favicon set, Tauri desktop + iOS icons, mdBook
  docs, svelte package, sveltekit starter template, root `logo-square.svg`
- `atomic-server/flutter` — Atomic Canvas web, iOS and Android launcher icons
- `atomic-saas/portal` — portal favicon set
- `atomic-saas/site` — marketing site icons (Next.js App Router picks up
  `icon.svg` / `apple-icon.png` by filename convention, so there are no
  `<link>` tags to keep in sync)

The sibling repo is located relative to this one (`../atomic-saas`) and skipped
with a warning when not checked out, so the generator still works from a lone
`atomic-server` clone.

### Why a push model rather than consumers declaring their own source

Web consumers could plausibly import a mark and let their bundler emit
favicons. The native ones cannot: Tauri wants `.icns`/`.ico` at paths fixed by
`tauri.conf.json`, Xcode wants an `AppIcon.appiconset` whose filenames are
pinned by `Contents.json`, and Android wants `ic_launcher.png` in five
`mipmap-*` directories. None of those offer a "fetch it from here" hook — the
files must exist, pre-rendered, at exact paths.

So a consumer-declared manifest would be a *third* place the paths are
written, after the framework config and the file layout itself. `TARGETS` in
`generate.mjs` is one list covering all of them, and it is the only place a
path appears that the framework did not already dictate.

## Wordmarks are hand-maintained

Five lockups embed the mark and are **not** generated:

| File | Lockup | Used by |
| --- | --- | --- |
| `logo.svg` | AtomicServer, with an 8px white keyline for placement on photos | main README, Dagger mounts it at `/logo.svg` |
| `browser/logo.svg` | Atomic Data Browser + TS badge | `browser/README.md` |
| `browser/data-browser/logo.svg` | identical copy of the above | nothing — unreferenced, safe to delete |
| `browser/data-browser/index.html` | AtomicServer, **animated** — inline in the boot splash | the app's first paint |
| `browser/data-browser/src/components/Logo.tsx` | AtomicServer, inline JSX, inked from the dark-mode setting | `AboutRoute.tsx`, `InvitePage.tsx`, `GettingStartedFlow.tsx` |

In each one the mark **is the letter `o`** of "Atomic": the glyph is not drawn
as a letter at all, the mark stands in for it. That is why they cannot be
generated from `src/` — position, scale and optical weight are tuned per
lockup against the surrounding letterforms.

They were updated by hand when the sweep replaced the ring in 2026. If the
mark ever changes again, these need re-cutting, and the tell that it was
missed is an `o` that no longer matches the icons. Note the sweep's band is
proportionally lighter than the old ring's (0.45 of its outer radius against
0.52), so it reads very slightly light next to bold letterforms — acceptable
at these sizes, but worth knowing before scaling a lockup down.

The splash and `Logo.tsx` were exactly that miss: both are lockups, but they
live inside an HTML and a TSX file rather than an `.svg`, so neither was on
this list and both kept the old ring until 2026-08. They are listed now.

Neither can become an `<img>` of `logo.svg`, which is what would have kept
them honest. The splash has to ink itself from `--text-splash` — the in-app
dark-mode override is applied before first paint, and an external image cannot
see it — and its `o` has to animate. `Logo.tsx` inks from the `darkMode`
setting, which is React state an image also cannot see.

In-app surfaces use `Logo.tsx`, not an `<img>` of `logo.svg`. The keyline is
the reason: it exists so the wordmark survives on a photo, and nothing removes
it again. A dark-mode `filter: brightness(0) invert(1)` over the image inks the
letters white but also keeps the keyline white — bloating the glyphs, closing
the counters of `o`, `e` and `r`, and flattening the orb's gradient to a plain
white dot. That was shipped on the welcome screen until 2026-08.

### What the letters are

Recovered by fitting candidates against the committed outlines, because
re-cutting a lockup for a new word is otherwise guesswork:

| | |
| --- | --- |
| Typeface | Montserrat **Bold (700)** |
| Size | 104 units (cap height 72.8, baseline at y=74) |
| Tracking | -4.182 units per gap, on top of the font's own kerning |
| `i` | **dotless** (`U+0131`) — the orb is the only dot in the logo |

Shaping `Atomic Data` with those settings reproduces every glyph in the
existing lockups to within 0.07 units, so they can be trusted for a new word.
Use a shaper that applies GPOS (fontkit, HarfBuzz); opentype.js reports
Montserrat's GPOS table but returns no kerning from it, which silently leaves
`At` about 4 units loose.

The mark is then dropped on the `o`'s centre by embedding `atomic-mark.svg`
unchanged under `translate(cx,cy) scale(30/31) translate(-50,-52)` — the scale
takes the mark's ring outer radius (31 in its own space) to 30, and the ring
sits 1 unit above the font `o`'s centre, which is the overshoot a round letter
needs to look the same size as a flat one.

### The animated `o`

The splash's mark spins while the app boots, and the sweep reads as the orb's
wake: opacity falling off with distance behind it. Three details are
deliberate.

**The falloff bottoms out at 30%, not 0.** The standalone spinners elsewhere do
fade to nothing, but this mark is also a **letter**: at zero the word reads
"At micServer" for a quarter of every revolution.

**The falloff is geometry, not a mask.** It was first written as
`mask-image: conic-gradient(…)` on the sweep path, which is by far the tidiest
way to express it and works in Chrome and Safari. Firefox rendered it as an
opaque block instead. CSS masking of SVG *geometry* is the unreliable case —
a path has no CSS box, so the reference box the mask resolves against is not
something to rely on. SVG has no angular gradient either, so the ramp is built
from arcs that all end at the orb and start progressively further back, each
adding a little alpha. Do not "simplify" this back into a mask.

Two consequences worth knowing:

- The arcs are **nested**, not laid end to end, so the only edge each one
  contributes is its start. Butt caps make that a clean radial step; round caps
  bulge into a visible scallop. The full-length base and the final segment keep
  round caps, because those two are the mark's own terminals.
- Band count trades DOM size against banding, and **has to scale with how
  large the mark is drawn** — the alpha step between bands is what the eye
  picks up. ~40 bands is smooth at spinner and splash size; a watermark several
  hundred pixels across visibly steps until roughly 200.

**Rotation is written as an explicit transform chain**,
`translate(50px,52px) rotate(…) translate(-50px,-52px)`, rather than a
`transform-origin`. Inside a transformed SVG subtree the origin depends on
`transform-box`, and the explicit chain has one meaning in every engine.
Placement stays an SVG `transform` attribute, copied from `logo.svg`, so a
stylesheet failure still leaves a correct static lockup.
