# Emoji & Cover Images

Notion/Loop-style per-resource decoration: an emoji "icon" shown next to the title everywhere the resource appears, and a full-width cover image at the top of the resource page.

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
