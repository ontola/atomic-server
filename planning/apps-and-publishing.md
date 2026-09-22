# Apps and publishing

Status: draft PR #1634. Do not merge until each renderer has a reviewable
publication path and browser coverage.

## Product model

- **App** is the thing a person creates and edits. It is a single resource that
  owns a renderer and can bind one or more Tables, Views or Documents. The
  current implementation stores Apps as Atomic `View` resources so table tabs
  and stand-alone screens share the same block and data model; `View` is an
  internal class name, not a separate product users must understand.
- **Layout** is a choice on that App: native table view, composed blocks, site
  pages or custom code. A site is an App with routes and navigation, and a
  block app can draw from several Tables. No separate Dashboard, Website or
  App root class is created.
- **Publication** is an explicit reviewed release of an App, with a URL,
  audience, selected data and allowed actions. Editing source never updates a
  live release. A public release contains only selected snapshots and assets;
  it never receives the owner's credentials or ambient write authority.
- **Template** creates an App and its data. It never grants publication or
  runtime rights.

The open Forms PR #1281 (`Forms #875`) has the right shape for public writes:
respondents use a named, validated submit action and the result Table stays
private. A published form App should expose that action, not general table
write rights. The Forms PR currently serves its live definition after Publish;
this publication model must specify whether an App release is pinned or live.

## Work in this PR

- [x] Store new block, site and code Apps as the same root class.
- [x] Offer one App creation entry with a starting layout choice.
- [x] Dispatch stand-alone Apps through one resource page.
- [x] Remove new Dashboard, Website and drive-local App root classes.
- [x] Keep site page inline editing against its source Documents and Tables.
- [x] Use one static release authorization and upload path for site and table
  Apps, with explicit selected rows and fields.
- [ ] Give code Apps a reviewed, credential-free public renderer with selected
  data and no implicit writes.
- [ ] Export composed blocks through the same release model, including exact
  stat/chart values and an explicit treatment of write-capable blocks.
- [ ] Unify publication controls and saved draft selection across layouts so
  AI and collaborators can review the same pending release.
- [ ] Remove remaining Dashboard/Website terminology from authoring tools,
  templates and implementation names after their replacements are in place.
- [ ] Verify creation, inline editing and public output in a real browser, plus
  focused TypeScript, Rust and unit coverage.

The current table App publisher exports a static table projection even when
its private layout is different. It must not be presented as full App
publication. Site page publication remains the richer renderer and retains its
inline editor. The publication controls need to converge before this PR is
ready for review.
