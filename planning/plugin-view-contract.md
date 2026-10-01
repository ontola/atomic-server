# A plugin contract strong enough for the table editor

The question (1 October 2026): what would the Atomic plugin contract and its
runtime need so that a third party could build something as capable as our
table editor or Kanban view, without rebuilding dialogs, menus, theming, focus,
sharing and file picking themselves?

Read against `develop` at `5d39b01`. Nothing was run. Earlier context:
"Critique of Michiel's plugins" (29 Sep, the first sketch of this question) and
"Plugins strategy and saas role" (30 Sep, the proxy and consent work).
Nothing below depends on atomic-saas.

## The short answer

Keep the sandboxed iframe as the only way third-party UI runs, and make the
contract four things instead of one:

1. **Data**: live, windowed collections with filter, sort and group;
   transactions that undo as one step; presence; and later Loro documents.
2. **Host services**: the host draws anything that must escape the frame's box
   or that needs the person's trust: dialogs, menus, confirm, toast, share,
   file and resource pickers, navigation, commands.
3. **Environment**: versioned design tokens, locale, focus and keyboard
   handoff, size, view state in the URL.
4. **A UI kit the plugin imports**: the same tokens as CSS, a set of web
   components (buttons, inputs, tags, value and cell editors per datatype), and
   a headless grid core (selection, keyboard, clipboard) that our own
   `TableEditor` also runs on.

Then prove it by **moving our own Kanban onto it**. Kanban is ~2k lines, already
a table view tab, and its imports are an exact checklist of what the contract
lacks (see "Kanban as the acceptance test"). When Kanban runs as a plugin and its
e2e specs pass, a third party can build a Kanban. The full table editor is the
same exercise with the grid core added.

## What exists today

There are two plugin view hosts, with different wire formats:

| Host | Where | Used for |
| --- | --- | --- |
| Class views | `views/PluginView/PluginView.tsx`, `pluginRPC.tsx`, `legacyViewAdapter.ts`; wire types in `browser/plugin/src/types.ts` | A plugin rendering a resource page |
| Drive apps | `chunks/AppPage/AppFrame.tsx`, `hostStore.ts`; wire in `browser/plugin/src/viewProtocol.ts`; frame client `server/src/plugins/assets/view-client.js` | Apps on their own page **and as a table view tab** (`TableViewTabs.tsx:174`) |

What a view can do, from `viewProtocol.ts` and `view-client.js`:

- **Data**: `app`, `data` (the table and row class it is pointed at),
  `get`, `query` (one property equals one value), `create`, `save`,
  `destroy`, `patch`, `search`, `subscribe` / `unsubscribe` (a bare "this
  subject changed" ping, not the change itself).
- **Host UI**: `pickResource`, `pickFile`, `navigate`, `proxyConnect`.
- **Integrations**: `proxyCapability`, `proxyConnections`, and signed proxy
  requests from a frame-held key.
- **Theme**: more than we thought. `useCreateThemeVars.ts` turns the
  styled-components theme into ~50 CSS variables (`--t-color-*`, `--t-size-1`
  to `15`, fonts, radius, shadows) and the host re-sends them when the theme
  changes (`AppFrame.tsx`, the `setStyle` effect). They are named after our
  internal theme object, though, with no promise that they stay.
- **Entry point**: the module exports `view({ root, store })`
  (`plugin_ui.rs`, the inline module script). No build step is assumed.

What it cannot do, which is Joep's list confirmed:

- No dialogs of its own, no menus or context menus that can leave the frame's
  rectangle, no confirm, no toast.
- No share dialog, though `components/Share/ShareDialog.tsx` takes only a
  `subject`, so exposing it is cheap.
- No focus or keyboard handoff. When focus is inside the frame, host
  shortcuts (search, sidebar, Escape to close) stop working, and Tab cannot
  move out of the frame into the host in a defined way.
- No reusable components: everything is hand-written DOM and CSS.
- No collection API: `query` is a single equality match, there is no sort,
  paging, grouping or delta, so a big table means fetching everything.
- No transactions or undo, no presence (`TablePage/TablePresence.tsx` exists
  for our own table and Kanban, plugins can't reach it), no Loro documents, no
  locale, no size or URL state.

Already in flight on Michiel's unmerged pin line for atomic-plugins
(`claude/atomic-plugins-pin-candidate19`, not on develop) and in his open PRs.
Build on it instead of next to it:

- `getMany`, `openResource`, `openExternal`, and row-access grants: #1788
  asks "Let <App> edit rows?" for an app added as a table view, scoped to that
  table.
- `store.getTheme()` / `onThemeChange()` with `colorScheme`, which closes
  #1738. This covers the dark-mode half of the token work below.
- Ops that wait on the person skip the 60 s request timeout.

None of it adds dialogs, menus, focus, keys, locale or resizing. A grep of
that branch's `view-client.js` finds none of them. The grants and the
table-view direction match this proposal; the UI services are the missing
half. `planning/extension-architecture.md` ("Consolidate the old PluginView
RPC and AppFrame bridge behind one public UI API") already calls for step 0
below.

Two things to settle before building more on top:

- **Two hosts.** Every new capability would be built twice. Converge
  `PluginView` onto the `AppFrame` bridge and `viewProtocol.ts` first.
- **The drive-app frame allows `connect-src *`** (`plugin_ui.rs`, the
  drive-plugin CSP). Fine for first-party apps, but a powerful third-party view
  should get network only for the origins its manifest declares, as
  `planning/plugins.md` ("Capabilities") already plans.

## Why not just share our React components

The frame is a different JavaScript realm on a null origin. A React component
from the host cannot be rendered inside it, and the plugin cannot render into
the host. That leaves three ways to "reuse" UI, and the contract needs all
three, each where it fits:

| Way | Where it fits | Why |
| --- | --- | --- |
| **Host draws it** on request | Dialogs, menus, confirm, toast, share, pickers, permission asks | It must escape the frame's box, or it involves trust (who is shared with, which file leaves the disk) |
| **Plugin imports a kit** and draws it inside the frame | Buttons, inputs, tags, value displays, cell editors, the grid | It is on the hot path: a keystroke cannot wait for a round trip to the host |
| **Host draws a form from a Class** | "New column", "Edit card", settings | Atomic already describes the shape; our `ResourceForm` renders any Class |

The third one is the Atomic-native shortcut. Most plugin dialogs are "fill in
these properties". If the plugin names a Class (or a list of Properties), the
host renders our own form with our own editors, validation and file fields,
and returns the values or the created resource. No UI code crosses the
boundary at all.

For anything a form cannot express, a dialog can host **another view of the
same plugin**: `ui.dialog({ view: 'new-column', args })` opens a host `Dialog`
whose body is a second sandboxed frame of the same release. The plugin keeps
full control of the content, the host owns the chrome, the stacking and
Escape.

Alternatives considered:

- **Run trusted plugins in the host realm** (no iframe). Fastest, full React
  reuse, but then a plugin holds the user's key and the store. Only for
  first-party code we ship, which is what built-in views already are.
- **Remote DOM** (the plugin emits a component tree, the host renders real
  host components, as Shopify does). True reuse with host rendering, but every
  interaction crosses the bridge, which is wrong for a grid. Worth it later
  for small contributions into host surfaces (a toolbar button, a sidebar
  panel), not for a view.

## The contract

Written as the frame sees it. Names are proposals.

### 1. Data

```ts
const rows = await atomic.collection({
  table,                        // or { parent, isA }
  filter, sort, groupBy,        // same shapes the table's view resources store
  window: { start: 0, size: 100 },
});
rows.items          // the current window, with propvals
rows.total
rows.on('change', delta => …)  // { inserted, removed, changed: [{ subject, propvals }] }
rows.setWindow(200, 100)
rows.setQuery({ filter, sort })

await atomic.transaction('Move card', tx => {
  tx.set(card, status, 'done');
  tx.set(card, sortOrder, between(a, b));
});                           // one commit per resource, one undo step

atomic.undo(); atomic.redo();  // or the host does it on Cmd+Z, see Environment

const presence = atomic.presence(table);
presence.set({ row, column, dragging });
presence.on('change', peers => …)

const doc = await atomic.loro(subject, 'description');   // later: rich-text cells
```

- `filter`, `sort` and `groupBy` should be **the same resources the table view
  tabs already store**, so a plugin view and our own table read one model, and
  a person can switch tabs between them without losing the filter.
- Deltas carry the new propvals, not a "something changed" ping. Today a view
  has to refetch after every `atomic.view.change`.
- Transactions give the host a label to show in undo and in history, and let
  it sign one batch instead of N single commits. The table's own undo is an
  app-level stack (`TablePage/helpers/useTableHistory.ts`), not Loro undo, so
  plugin transactions should go on that same stack.
- Schema writes belong here too. Kanban creates a select property on the fly
  (`Kanban/createSelectProperty.ts`). A plugin needs `atomic.schema.addColumn`
  or similar, behind the `edit-classes` grant that exists.
- Loro access is the last item. Our grid edits markdown cells as text today,
  so it is not on Kanban's path.

### 2. Host services

```ts
await atomic.ui.form({ class: Task, title: 'New task', initial })   // → values or subject
await atomic.ui.dialog({ view: 'column-settings', args, width })    // → whatever that view returns
await atomic.ui.confirm({ title, body, danger: true })
atomic.ui.toast({ text, kind })
await atomic.ui.menu({ at: { x, y }, items: [{ id, label, icon, shortcut, danger, children }] })
atomic.ui.resourceMenu(subject, { at })    // our own ResourceContextMenu, with Open, Share, Delete, …
atomic.ui.share(subject)                   // our ShareDialog
await atomic.ui.pickFile({ accept, multiple })   // exists
await atomic.ui.pickResource({ isA })            // exists
atomic.ui.open(subject, { in: 'page' | 'side' | 'dialog' })  // ExpandedRowDialog for 'dialog'
```

Rules that keep this safe:

- **The host owns the chrome.** Every host-drawn dialog and menu shows the
  plugin's name, so a plugin cannot draw something that looks like a host
  sign-in or share prompt.
- **Trust-bearing actions finish in host UI.** `share` opens the dialog; the
  person does the sharing. The plugin learns nothing it could not read anyway.
- **Coordinates are frame-relative.** The host maps them through the frame's
  bounding rect, so menus appear where the person right-clicked, and can
  overflow the frame.
- **One question at a time per frame**, as `proxyConnect` already does
  (`AppFrame.tsx`, "One question at a time").
- `resourceMenu` gives plugins our context menu for free, including actions
  added later, rather than each plugin reinventing Delete.

### 3. Environment

- **Design tokens as a contract.** Rename the `--t-*` set to a documented,
  versioned `--atomic-*` set (colour roles, spacing, radius, type scale,
  shadows, focus ring, motion), plus `color-scheme` and a `data-theme`
  attribute. Keep `--t-*` as aliases for one release. The host already pushes
  them live; the change is the promise.
- **Locale and formatters.** Pass `locale`, and expose the host's date and
  number formatting, so dates in a plugin match dates in the table. Plugins
  bring their own string catalogs; wuchale is compile-time and cannot cross.
- **Keyboard.** The frame client listens for `keydown` and forwards any event
  the plugin did not `preventDefault` to the host, which runs its own
  shortcuts (search, Escape to close a dialog, Cmd+Z to undo the plugin's last
  transaction). A plugin registers commands with `atomic.commands.register({
  id, label, shortcut, run })`. These go straight into the host's existing
  action registry (`actions/types.ts`, `ActionDefinition`), so they show in
  menus and shortcut help. They can even become AI tools through `asTool`. The host reserves a short list it never forwards to the
  plugin.
- **Focus.** `atomic.focus.onEnter(edge)` when the host tabs into the frame
  (first or last), and `atomic.focus.leave('next' | 'previous')` when Tab
  runs off the plugin's last control. Without this, keyboard users get stuck
  in the frame, which also fails WCAG.
- **Size and placement.** `context.placement` is `page`, `tab`, `dialog` or
  `inline`; inline views report their height with `atomic.resize(h)`.
- **View state.** `atomic.state.get()` / `set()` writes into the URL's query
  string (scroll anchor, selected card, open group), so reload and links keep
  a plugin's place, as they do for our table.

### 4. The UI kit

Three packages, published from `browser/`, MIT like the rest:

- **`@tomic/tokens`**: the token CSS from Environment, plus a base stylesheet
  (reset, typography, focus ring). Already 80% there in
  `useCreateThemeVars.ts` and `reset.css`.
- **`@tomic/ui`**: framework-agnostic **web components**:
  `<atomic-button>`, `<atomic-input>`, `<atomic-select>`, `<atomic-tag>`,
  `<atomic-value>` (renders any value by datatype, like `ValueComp`),
  `<atomic-avatar>` (presence), and one editor per datatype mirroring
  `TablePage/EditorCells/` (string, markdown, number, boolean, date,
  date-time, select, resource, resource array, URI, JSON). Web components
  because a drive app is one ES module with no build step, written by people
  and by the assistant, in whatever framework; React wrappers are a thin
  extra. Pickers inside these editors call the host services, so a resource
  cell in a plugin opens our resource picker.
- **`@tomic/grid-core`**: the headless part of `chunks/TableEditor/`, in
  plain TypeScript: the cursor modes and handler table in
  `helpers/keyboardHandlers.ts`, cell selection, copy and paste
  (`helpers/clipboard.ts`, `hooks/useCopyCommand.ts`, `usePasteCommand.ts`),
  column sizes and order. `FancyTable`'s props (`TableEditor.tsx`, the
  `FancyTableProps` interface) are already almost a data-agnostic interface:
  `columns`, `itemCount`, render-a-row, and `onCopyCommand`,
  `onPasteCommand`, `onClearCells`, `onUndoCommand`, `onColumnReorder`. Our
  React `TableEditor` becomes the first consumer, so the core cannot drift
  from the grid people actually use.

The grid core is also what makes the table reusable outside Atomic, which Joep
asked about on 29 September: the same core plus a non-Atomic data adapter.

## Kanban as the acceptance test

The imports of `chunks/TablePage/Kanban/` are the work list. Each line is what
Kanban uses today and what replaces it in the contract.

| Kanban uses | Contract piece |
| --- | --- |
| `@tomic/react` collection and resource hooks | `atomic.collection` with `groupBy`, deltas |
| `TablePresence` | `atomic.presence` |
| `@dnd-kit/core`, `useDragSensors` | Inside the frame; it works there. Cross-frame drag is out of scope |
| `fractionalSortOrder` | Ship in `@tomic/ui` as a helper |
| `createSelectProperty` | `atomic.schema` behind `edit-classes` |
| `Dropdown`, `DefaultTrigger` | `atomic.ui.menu` |
| `ResourceContextMenuContext` | `atomic.ui.resourceMenu` |
| `ExpandedRowDialog` | `atomic.ui.open(subject, { in: 'dialog' })` |
| `Tag`, `tagColours`, `ValueComp`, `InputStyles`, `IconButton`, `Loader`, `SkeletonButton` | `@tomic/ui` and `@tomic/tokens` |
| `rowDefaults`, `useCreateRow`, `useAllMembers` | `atomic.transaction` create with the view's defaults; a `members` read |

Done means: Kanban ships as a first-party plugin in the same release format a
third party would use, behind a flag, and the existing Kanban e2e specs pass
against it unchanged. Anything we had to special-case for it is a gap in the
contract and gets fixed there.

### What Kanban does not prove

Kanban is a view tab inside the table page. The host keeps the table, its
filters, view tabs and toolbar, so Kanban exercises data and host services,
which is the shape most third-party views take. It does not touch the grid's
hard parts: keyboard navigation, cell selection, clipboard and per-datatype
editors. Those are proven separately by step 5, then by the grid tab running
as a plugin next to ours (step 6). Moving the whole table page (filters, tabs,
columns) into a plugin comes last, if ever.

## Plan

Each step lands on its own.

- [ ] **0. One host.** Move `PluginView` onto the `AppFrame` bridge and
      `viewProtocol.ts`. Declared network origins instead of `connect-src *`
      for third-party releases.
- [ ] **1. Environment.** Versioned `--atomic-*` tokens with `--t-*`
      aliases, locale, placement, resize, keyboard forwarding, focus edges,
      URL view state.
- [ ] **2. Host services.** `form` (from a Class), `dialog` (sub-view),
      `confirm`, `toast`, `menu`, `resourceMenu`, `share`, `open`. Each with
      a test in `browser/plugin` like `viewProtocol.test.ts`.
  - [x] Drive apps (`AppFrame`): `store.ui.confirm`, `toast`, `menu`,
        `resourceMenu`, `share`, `openResource`, `environment` (locale and
        placement), and key forwarding. `chunks/AppPage/hostUI.tsx`.
  - [ ] `form` from a Class, `dialog` as a sub-view.
  - [ ] The packaged `PluginView` host (lands with step 0).
- [ ] **3. Data.** `collection` with windows and deltas, `transaction` with
      undo, `presence`, `schema`.
- [ ] **4. Kanban as a plugin**, behind a flag, against the existing e2e
      specs.
- [ ] **5. UI kit.** `@tomic/tokens`, `@tomic/ui` web components including
      the datatype editors, `@tomic/grid-core` extracted from `TableEditor`
      with our grid as its first user.
- [ ] **6. The table as a plugin.** Same exercise as Kanban, plus Loro
      documents for rich-text cells.

Steps 1 and 2 are where a third party feels the difference first, and they
are small. Step 3 is the largest and decides whether big tables stay fast.
Step 5 can start in parallel with 3.

## Decisions for Joep

1. **Prove it on Kanban by moving our own Kanban onto the contract.**
   Recommended. The alternative, designing the contract on paper first, tends
   to miss exactly the things the import list above shows.
2. **Web components for `@tomic/ui`**, with thin React wrappers. Recommended,
   because drive apps are build-free modules and the assistant writes them.
   The alternative is a React-only kit, cheaper for us and harder for
   everyone else.
3. **Third-party UI only ever runs in the frame.** Recommended. In-realm
   plugins stay first-party only.
4. **Who owns it.** Michiel's current work is the integration side (proxy,
   manifests, importers), not the view contract. Step 0 touches his bridge, so
   it is worth agreeing with him who builds steps 0 to 2.
