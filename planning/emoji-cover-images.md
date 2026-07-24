# Emoji & Cover Images

> **Status: implemented (July 2026).** Deviations from the design below:
>
> - **No class `recommends` changes.** Decorations are edited via the page UI
>   (like Notion), not via forms, so adding them to `recommends` would only
>   clutter new-resource forms. Rendering is class-agnostic as designed.
> - **Articles already had a cover** via an argu-specific property
>   (`atomicArgu.properties.coverImage`, an ad-hoc `/Folder/...` subject).
>   `ResourceDecorations` reads it as a legacy fallback and migrates writes to
>   the canonical `https://atomicdata.dev/properties/coverImage`; the old
>   `ArticleCover` component was deleted.
> - **Sidebar expandable rows** (folders) have no icon slot — the expand caret
>   occupies it. The emoji rests in the caret's slot and yields to the caret on
>   hover/focus, same swap pattern as the drag grip.
> - **Client-side `validate: false`** on the decoration setters: the new
>   property subject doesn't resolve on atomicdata.dev yet, so client datatype
>   validation would fail on the fetch. The server validates commits against
>   its local copy from `lib/defaults/`.
> - Mounted in: ResourcePageDefault, ArticlePage, FolderPage,
>   DocumentV2FullPage. Emoji glyph surfaces: sidebar, inline links, search
>   ResultLine, resource cards. The emoji picker gained a "Remove emoji" action
>   (also fixes tags, which previously couldn't clear their emoji).
> - **Decorations live in EditableTitle, not a separate block** (second
>   iteration): the emoji renders inline in the title at title size (click
>   opens the picker; `stopPropagation` keeps it from starting a title edit),
>   and the "Add icon"/"Add cover" affordances are an opt-in
>   `withDecorations` prop on EditableTitle — rendered in the same row as the
>   title, to its right, revealed by hovering the title row.
> - **The cover is full-bleed**: `ResourceCoverImage` is mounted above each
>   view's padded container, directly under Main, so it touches the edges
>   (no radius, no padding).
> - **All full-page resource views carry decorations** (third iteration):
>   ResourcePageDefault, Article, Folder, DocumentV2, Table, Meeting,
>   ChatRoom, AIChat (cover in the chat header slot), Drive, and Bookmark.
>   Skipped: CollectionPage (server-generated resource — commits don't
>   persist), FilePage, TagPage (has its own emoji UI for the tag itself).
>   ChatRoomPage's wrapper was restructured (outer flex column, inner
>   `flex: 1; min-height: 0`) so the pinned-input chat layout survives with a
>   cover above it.
> - **Menu actions** `setEmoji` / `setCover` in the action registry, hidden by
>   default via a new `searchOnly` flag on `ActionDefinition`/`DropdownItem` —
>   they only surface in the searchable ⌘M menu when the filter matches
>   (keywords: emoji/icon/glyph, cover/banner/image…). Labels flip between
>   Add/Change based on current state. They open `EmojiPickerDialog` (emoji
>   picker in a dialog, lazily mounted) and `CoverPickerDialog`, both provided
>   as capabilities (`openEmojiPicker`/`openCoverPicker`) by
>   ResourceContextMenu, same pattern as `showCodeUsageDialog`.

Notion/Loop-style per-resource decoration: an emoji "icon" shown next to the title everywhere the resource appears, and a full-width cover image at the top of the resource page.

## Avatars / image icons (implemented July 2026)

Profile pictures for Drives and Users (Agents), doubling as "custom emoji"
image icons for any resource — one concept, one property, shown in the same
glyph slot the emoji uses today.

### One property, not two

`https://atomicdata.dev/properties/icon` (shortname `icon`, AtomicURL →
`server:file`). A user's avatar and a folder's custom image icon are the same
mechanical thing: a small image rendered wherever the resource's name appears.
Splitting `avatar`/`icon` by class would just duplicate every render branch.

Glyph precedence everywhere becomes: **icon image > emoji > class icon**. The
picker keeps the model simple by treating it as one slot with two storage
forms: choosing an emoji clears `icon`, uploading an image clears `emoji`
(precedence still resolves legacy both-set states).

### Client-side resizing — no server endpoint

Local-first rules out `?w=&f=` renditions as the mechanism (offline peers
must see avatars too). So the file is made small **at upload time, in the
browser**, and consumers render it as-is:

- `helpers/resizeImage.ts`: `createImageBitmap` → `OffscreenCanvas` →
  `convertToBlob({ type: 'image/webp', quality: ~0.8 })`. Square
  center-crop, max 256×256 (crisp up to ~128px display at 2x; icons render
  ≤40px almost everywhere). Typical result: 5–15 KB.
- Upload with `parent` = the decorated resource (rights + lifecycle
  inheritance, same as covers). The local blob is cached by ClientDb, so the
  avatar renders offline via `useFileObjectUrl` — display is
  `localBlob ?? downloadUrl`, a plain `<img>`, no query params, no `Image`
  srcset machinery.
- The helper takes a `{ maxSize, square }` option so a later pass can also
  pre-shrink oversized cover uploads (max-dimension mode, no crop).

### Rendering

- Finally extract the shared `ResourceGlyph` component (the emoji-else-class-
  icon logic is now duplicated across SidebarItemTitle / ResultLine /
  ResourceCardTitle / ResourceInline; a third branch tips the balance).
  Circle mask for Agents, ~20% rounding otherwise.
- Avatar-specific surfaces beyond the existing glyph slots: presence bubbles,
  share-menu agent rows, commit attribution, the drive switcher and the
  sidebar drive button.

### Editing

The existing icon slot grows an "Upload image" affordance: in the emoji
popover and in `EmojiPickerDialog`, a header row next to "Remove emoji" with
a file input → resize → upload → set `icon`. The `setEmoji` menu action's
"Add/Change icon" label already covers both forms.

### Repositioning / zooming

Two different geometry problems, two different answers:

**Avatar: bake the crop at upload.** The upload dialog shows a square/circle
mask over the image with drag-to-position and a zoom slider; the stored 256²
webp IS the framed result. No metadata anywhere, zero interpretation at the
dozens of tiny render sites, works offline by construction. The file is
created 1:1 for this avatar (parented to the resource), so destructive is
fine — re-framing means re-picking the original from disk, the model every
avatar UI (GitHub, Slack) has trained users on.

**Cover: a focal-point property on the *decorated resource*.** Baking can't
work here: the banner's aspect is fluid (responsive width, clamped height),
so there is no fixed crop to bake — framing must be interpreted at render.
Store `coverImageFocus` (float 0–1, vertical; default 0.5) NEXT TO
`coverImage` on the folder/document, rendered as
`object-position: 50% ${focus * 100}%`. A "Reposition" button on the banner
enters drag mode; commit once on release (not per pointermove). This is
exactly Notion's model.

Why the focal point lives on the decorated resource and not elsewhere:

- *Not on the File*: framing is a property of the usage, not the image — the
  same photo can be the cover of two resources with different framing, and
  picking someone else's file as cover mustn't require write rights on it.
- *Not in-file metadata (EXIF-style)*: opaque, needs parsing on every
  consumer, invalidates cached bytes on every nudge.
- *Not an intermediate "placement" object*: an extra resource + fetch hop for
  every banner render, plus commit/GC lifecycle, to store one float. Only
  worth revisiting if art-direction ever needs multiple crops per aspect.

---

## Data model

Two properties, both universal decorations — any resource may carry them, rendering is class-agnostic:

| Property | Subject | Datatype | Notes |
|---|---|---|---|
| emoji | `https://atomicdata.dev/properties/emoji` | string | **Already exists** (`lib/defaults/table.json:223`), used by Tag. Reuse as-is. |
| cover image | `https://atomicdata.dev/properties/coverImage` (new) | AtomicURL → `server:file` | Reference to a File resource, not a URL string. |

Why a File reference instead of an image URL string:

- Gets responsive renditions for free (`?w=&f=webp|avif&q=` on the download endpoint).
- Stored dimensions (`imageWidth`/`imageHeight`) prevent layout shift.
- Uploading with `parent` = the decorated resource means the cover inherits the resource's read rights and lifecycle.
- Offline blob support already exists in `@tomic/react`'s `Image`.

(External URLs can still be supported later by also accepting `imageUrl`, but v1 is file-only.)

### Deliberately deferred (v2)

- `coverImagePosition` (float 0–100, vertical focal point) — Notion's "Reposition". Trivial to add later; omitting keeps v1 small.
- Custom **image** icons (File ref `icon` property). Precedence would become `icon > emoji > class icon`. Emoji covers 95% of demand.
- Built-in cover gallery / gradients / Unsplash. v1 = upload or pick an existing File.
- Using the cover as `og:image` in server-side HTML rendering.

### Class integration

Add `emoji` + `coverImage` to `recommends` of the classes where the forms should offer them: Article, Folder, Drive, Document, Table, ChatRoom. This only affects generated forms — **rendering must not check class**; any resource with the property shows it. That's the Atomic-idiomatic move: classes recommend, they don't gate.

## Rendering

### Resource page (ResourcePageDefault, ArticlePage, DocumentV2FullPage, FolderPage, TablePage, …)

- Cover: full-bleed banner above the content column, fixed height (~20vh, clamp 140–280px), `object-fit: cover`, rendered with the existing `Image` component (sizes up to 2000w already in `DEFAULT_SIZES`).
- Emoji: large (~2.5rem) glyph, Notion-style — overlapping the cover's bottom edge when a cover exists, inline before the `EditableTitle` otherwise.
- Empty-state affordances: on hover over the title block (and only with write rights), ghost buttons "Add icon" / "Add cover". This is the entire discovery surface; no settings menu needed.

Rather than patching each page view, extract one `ResourceDecorations` (cover + emoji + affordances) component and mount it in the shared page chrome the views already use, so new views get it for free.

### Everywhere the title appears

Precedence rule, one shared hook (`useResourceGlyph(resource)`): emoji if set, else `getIconForClass`. Insertion points found in the survey:

- Sidebar: `SidebarItemTitle.tsx` `LeadingSlot` (currently class icon only).
- Inline links: `ResourceInline.tsx` `DefaultInline`.
- Search: `SearchBox/ResultLine.tsx`.
- Cards: `ResourceCardTitle.tsx`; card views may additionally show the cover as the card's media area (small rendition, `w=300`).
- Folder grid items, NavBar current-resource title.

Perf note: emoji lives on the resource itself, which these components have already loaded — zero extra fetches. The cover is only fetched where it's actually displayed.

### Editing

- Emoji: clicking the glyph (or "Add icon") opens the existing lazy `EmojiInput` popover; include a "Remove" action. Writes with `useString(resource, emoji, {commit: true})` like TagPage does.
- Cover: "Add cover" opens a small popover: **Upload** (existing `/upload` endpoint, `parent` = this resource) or **Pick existing** (SearchBox filtered to `server:file` with image mimetypes). "Change" / "Remove" appear on cover hover. Removing deletes the property; only delete the File itself if it was uploaded via this flow and is a child of the resource.

## Distribution mechanics (the non-obvious part)

1. Define `coverImage` in `lib/defaults/` (next to `emoji` in table.json, or default_store.json) so self-hosted servers have it locally.
2. Publish the same property on atomicdata.dev, since the subject must resolve.
3. Regenerate TS ontologies with `@tomic/cli` (`browser/lib/atomic.config.json` → `browser/lib/src/ontologies/`); until regen, the subject can be hardcoded in `urls.ts` the way `emoji` already is (`urls.ts:162`).
4. Existing servers only pick up the new property + class `recommends` via `ATOMIC_REPOPULATE_DEFAULTS` — mention in release notes.

## Edge cases

- Dangling cover ref (file deleted): `Image` render error → hide the banner, keep the "Add cover" affordance.
- Cover is decorative: empty `alt`, `aria-hidden` on the emoji glyph in duplicated contexts (sidebar already has the text label).
- No write rights: render decorations, never the affordances.
- Emoji property is plain string — technically any string can be stored; renderers should just render it (grapheme clustering handles multi-codepoint emoji; don't validate).
