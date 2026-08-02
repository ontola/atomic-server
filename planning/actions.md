# Unified Actions

## Problem

Resource actions (view, edit, delete, share, history, favorite, …) are invocable
from many surfaces — context menus, keyboard shortcuts, the ⌘K overlay, AI tools,
the JS API — but each surface enumerates and implements them independently:

- Four parallel registries enumerate overlapping verbs: `ContextMenuOptions`
  (ResourceContextMenu), the `shortcuts` object (HotKeyWrapper), `TOOL_NAMES`
  (useAtomicTools), and the URL builders in `helpers/navigation.tsx`.
- `resource.destroy()` is wired up independently in 5+ places, each
  re-implementing confirmation + toast + cleanup.
- The shortcuts help page (`ShortcutsRoute.tsx`) is hand-synced prose.
- The ⌘K overlay exposes exactly one verb (navigate to search result).
- Coverage is inconsistent: Delete has no hotkey and no AI tool; Share/History/
  Favorite exist only in the context menu.
- There is no MCP server yet; when one exists it would be a fifth enumeration.

## Design

One module, `src/actions/`, where each action is a single definition and every
surface is a *projection* of it.

```ts
interface ActionDefinition {
  id: string;                  // stable; matches old ContextMenuOptions values
  scope: 'resource' | 'app';   // takes a target subject vs. app-level
  section: 'view' | 'action' | 'danger'; // menus render dividers between sections
  label: string | ((ctx) => string);      // menu label / palette title
  helper: string;              // tooltip today; AI/MCP tool description later
  icon?: (ctx) => ReactNode;
  shortcut?: string;           // from the `shortcuts` registry; shown as chip
  keywords?: string[];         // extra search terms for searchable surfaces
  danger?: boolean;            // surface must confirm before running
  confirmation?: { title; confirmLabel; body(ctx) }; // what the dialog shows
  available?: (ctx) => boolean; // hidden when false (e.g. needs canWrite)
  disabled?: (ctx) => boolean;  // shown greyed (e.g. already on that route)
  run: (ctx) => void | Promise<void>; // THE one implementation
}
```

`ActionContext` is assembled once per target by the `useActionContext(subject,
overrides)` hook: store, navigate, resource, canWrite, favorites, AI-sidebar
add-to-chat, scope/new-child navigation, current subject/pathname, plus
surface-provided capabilities (`showCodeUsageDialog`, `onAfterDelete`,
`external`). **Capability gating**: an action that needs a capability declares
it via `available`, so surfaces that can't provide it simply don't list it.

Three kinds of actions, modeled by what `run` does:
- **navigation** (view, data, edit, share, history, import, move-to-parent):
  `run` = `navigate(xURL(subject))`; safe on every surface.
- **mutation** (delete, favorite): the duplication hotspot; `danger` +
  `confirmation` live on the definition so confirm-wiring is uniform.
- **UI effects** (add to chat, use in code, search children): gated on
  capabilities, only listed where they make sense.

## Surfaces

| Surface | How it projects the registry |
|---|---|
| Right-click / kebab menus | `ResourceContextMenu` builds `DropdownItem[]` from definitions; `showOnly` keeps filtering by id (17 call sites unchanged) |
| ⌘M "more" menu | Same menu with the ⌘M shortcut bound. Every `DropdownMenu` is searchable by default: filter input at top, type-to-filter over label+keywords, arrows+enter (right-click / kebab included). |
| ⌘K overlay | Actions appear as a section next to search results. **Placement policy, not unified ranking**: actions section capped at ~3, shown only on a strong prefix/synonym match against the action vocabulary, never interleaved with resource results |
| Hotkeys | `HotKeyWrapper` registers definitions that carry `shortcut` |
| Shortcuts help page | Rendered from the registry (kills the hand-synced prose) |
| AI tools | Simple verbs derive `tool({ description: helper, execute: run })`; rich tools (query, create_table) stay bespoke |
| MCP server (future) | Same derivation, different protocol |

## Rollout

1. **Registry + searchable ⌘M menu** (this slice): `src/actions/` with all
   current context-menu actions + move-to-parent (⌘↑, Finder convention);
   `ResourceContextMenu` renders from the registry; `DropdownMenu` gains a
   `searchable` mode (on by default for all dropdown-style context menus).
2. **⌘K**: actions section in `SearchOverlay` per the placement policy.
3. **Hotkeys + shortcuts page** derived from the registry; collapse the
   remaining scattered delete implementations onto the delete action.
4. **AI tools / MCP** derivation for simple verbs.

## Non-goals

- RTE slash-menu commands and table-editor copy/paste commands: editor-
  granularity commands on selections, not resource actions. Out of scope.
- Moving the registry to `@tomic/lib`: almost every action touches navigation,
  dialogs, or toasts. Headless extraction can happen when the CLI/MCP server
  needs it.

## Decisions

- **Mixed ⌘K, not a second shortcut**: action queries (small closed verb set)
  and resource queries (open noun set) barely overlap; grouped sections with a
  deterministic placement policy beat interleaved ranking. ⌘M *is* the
  dedicated actions palette, scoped to the current resource.
- **Action ids keep the old `ContextMenuOptions` string values** so `showOnly`
  call sites and `menu-item-<id>` test ids don't churn.
- **All dropdown-style context menus are searchable** (right-click, kebab, ⌘M).
  Pass `searchable={false}` only for tiny menus where a filter would be noise.
- **Move to parent** gets ⌘↑, matching Finder's "go to enclosing folder".
