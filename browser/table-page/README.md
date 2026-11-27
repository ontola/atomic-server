# @tomic/table-page

The complete SDK-aware Atomic TablePage, consumed through a pinned Git submodule.
The package owns the full page, TableResource, built-in table/board/calendar/
dashboard views, saved views, forms, history, filters and exports. It reuses
`@tomic/resource-ui` for whole record widgets and `@tomic/table` for the SDK-free
grid. Atomic's resource route imports this same page.

Mount `TablePage resource={resource}` under the existing `@tomic/react`
StoreContext, styled-components ThemeProvider, resource-UI host provider, locale
provider and the shared overlay/form contexts required by the controls.
`ResourceUIHost` describes navigation/search/history, shell language/drive
settings and external app/workspace integration. It does not render built-in
views or replace Resource/Property field binding.

The shared `CustomContextItemsProvider` is required for the page’s export and
workspace actions. The host also wires the canonical resource-menu trigger/state
contexts and `RightPanelContext` to its real resource menu and comments panel.
Atomic supplies its existing providers and panel implementation. Their default
context values do not implement menus or comments for an external consumer; ELFA
must connect those shell features explicitly. Table-owned cell, heading, filter
and view menus remain inside this package.

The existing Atomic state/query behavior is preserved. Backend implementations
must support the SDK operations used by the page or explicitly report an
unsupported operation. Catalog discovery and lens evolution remain follow-ups.
The `test/providers` fixture supplies portable shell services and the canonical
shared theme without importing the Atomic application's router or settings.

Saved-tab renaming targets the tab whose menu was opened and checks its current
table membership, owner, account and write permission after loading. Property
name inputs provide unique accessible validation feedback while retaining the
existing save and focus policy. Filter editors retain incomplete numeric drafts
and unavailable stored choices for repair; unsupported filters remain removable.
Hosts can lock filter controls during their own pending operations without
changing the page's existing read-only local filtering policy.

Backend requirements remain explicit. CSV export currently uses Atomic's real
`/export?format=csv&subject=…` endpoint obtained through `Store.getServerUrl()`;
uploads, collections, permissions and history likewise retain the existing SDK
operations. An ELFA adapter must support each operation or report it unavailable.
A placeholder server URL does not provide working CSV export. These backend gaps
are integration work, not permission to replace the complete page with slots.
