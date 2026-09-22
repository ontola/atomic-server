# Unified views and publishing

Status: implementation in progress on `codex/unified-publishing`.

The same Atomic data should support native table views, composed views, custom
JavaScript views, and public delivery. A drive remains the authority boundary.
No mandatory workspace resource is introduced.

## Product contract

- A **View** is an interface over one or more explicitly bound sources. It may
  render with native controls, composed blocks, or custom code.
- A **Template** creates resources and views. It does not grant runtime rights.
- A **Publication** pins a reviewed output and names its audience, data selection,
  and available actions. A publication is distinct from a code release.
- External credentials and app signing keys stay on the execution host. Neither
  view source nor public artifacts contain them.

The open Forms PR #1281 (`Forms #875`) has an important concrete write model:
anonymous respondents submit through a form-specific validated endpoint, while
the results table stays private. Its fields and layout are blocks within a form;
the form renderer is reusable across builder preview and public delivery. This
is an action capability for a future published view, not a general public write
grant. The PR serves its current definition after a Publish toggle, unlike the
immutable website deployment. Unification must make that freshness choice
explicit and preserve the dedicated submit validation.

## First implementation

- [x] Let a composed dashboard render directly from a View resource, with old
  Dashboard resources still readable.
- [x] Remove the extra Dashboard resource from new table dashboard views.
- [x] Have the standalone Dashboard creation flow produce a composed View.
- [x] Have the Assistant's `create_dashboard` flow produce the same View model.
- [x] Give View resources an independent route and keep table tabs working.
- [x] Reuse the existing immutable publication host for Views as well as Sites.
- [x] Ship a read-only table projection from an explicit View row and field
  selection, while preserving private source resources.
- [ ] Update coverage and verify focused tests, typecheck and browser behavior.

The first View publisher deliberately exports a table projection, even when
the private View uses another renderer. It does not export custom App code,
composed blocks, computed fields, actions, or a live query. Its selection is
restored from the active publication, and unpublished selection changes live
only in the current editor session. Future publication drafts should be stored
as private resources so AI and collaborators can edit them before review.

## Later migration

- [ ] Adapt custom App screens to the same View source/binding contract without
  giving iframe code credentials or ambient authority.
- [ ] Route website pages through Views and documents, retaining immutable
  deployment and URLs during migration.
- [ ] Support reviewed live reads and named visitor actions. Use the Forms PR's
  submit path for surveys rather than generic public table writes.
- [ ] Extend the portable template format to include these Views and publication
  intents without copying credentials or active grants.
- [ ] Retire the Dashboard label and custom App authoring entry point only after
  existing resources and bookmarks have compatibility paths.
