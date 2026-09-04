# Unified Actions

**Status:** Steps 1–4 shipped. The registry in
`browser/data-browser/src/actions/` (`ActionDefinition`, `resourceActions`,
`appActions`, `useActionContext`) is the source for the searchable ⌘M menu,
`ResourceContextMenu`, the ⌘K actions section, hotkeys, the shortcuts overlay
and `/app/shortcuts` page, and simple AI tools. Fork verbs from
[`drafts-and-suggestions.md`](./drafts-and-suggestions.md) already land there.

Remaining: a future MCP server can reuse `deriveActionTools`; specialized
`destroy()` call sites (table rows, views, tags) stay local — they are not
the resource-delete verb.

## Problem

Resource actions (view, edit, delete, share, history, favorite, …) are invocable
from many surfaces — context menus, keyboard shortcuts, the ⌘K overlay, AI tools,
the JS API — but each surface used to enumerate and implement them independently.

## Design

One module, `src/actions/`, where each action is a single definition and every
surface is a *projection* of it.

```ts
interface ActionDefinition {
  id: string;                  // stable; matches old ContextMenuOptions values
  scope: 'resource' | 'app';   // takes a target subject vs. app-level
  section: 'view' | 'action';  // menus render dividers between sections
  label: string | ((ctx) => string);
  helper: string;              // tooltip; AI/MCP tool description
  shortcut?: string;           // from `actions/shortcuts.ts`
  asTool?: boolean;            // derive an AI tool from helper + run
  run: (ctx) => void | Promise<void>;
}
```

`ActionContext` is assembled by `useActionContext` (React) or
`buildActionContext` (AI tools). Surfaces that cannot provide a capability
simply do not list the action (`available`).

## Surfaces

| Surface | How it projects the registry |
|---|---|
| Right-click / kebab menus | `ResourceContextMenu` builds `DropdownItem[]` from definitions |
| ⌘M "more" menu | Same menu, `searchable` |
| ⌘K overlay | Actions section, capped at 3, prefix/synonym match only, never interleaved with resource results |
| Hotkeys | `HotKeyWrapper` registers definitions that carry `shortcut` |
| Shortcuts help | `listShortcutHelp()` — overlay and `/app/shortcuts` |
| AI tools | `deriveActionTools` for `asTool` verbs; rich tools stay bespoke |
| MCP server (future) | Same derivation, different protocol |

## Rollout

1. **Registry + searchable ⌘M menu** (2026-07-08): shipped.
2. **⌘K**: actions section in `OverlayContainer` `SearchOverlay` per the placement policy.
3. **Hotkeys + shortcuts page** derived from the registry. Shortcut strings live in `actions/shortcuts.ts`; `HotKeyWrapper` re-exports them.
4. **AI tools**: `delete_resource`, `favorite_resource`, `open_share_settings`, `show_history` derive from the matching verbs.

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
- **Right-click menus are not searchable**; ⌘M and the navbar kebab are.
- **Move to parent** gets ⌘↑, matching Finder's "go to enclosing folder".
- **⌘K match is a prefix of id / label word / keyword**, never a mid-word
  substring, and ignored below 2 characters — so a resource-name query does
  not grow an Actions section.
