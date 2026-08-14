# Forks, drafts, publishing, and suggestions

> **Status:** design agreed 2026-07-14; **terminology split 2026-07-15.** Covers
> milestone 11 (Local-first headless CMS): issue #467 (drafts / publishing /
> archiving) and the mechanism half of #1000 (edit content from a webpage).
> Content i18n (#1069) is out of scope for this round.

## Two orthogonal things, neither of them CMS-specific

The CMS ask decomposes into two generic capabilities. Neither is a Website
feature; there is no `Website`-specific code path anywhere in this plan.

1. **Visibility is location.** A resource is public because it lives somewhere
   public. Publishing, unpublishing, and archiving are *moving a resource* —
   an operation that already exists.
2. **A proposed change is a fork.** A `Fork` resource names the resource it
   proposes to change, via `originalSubject`. Merging squashes it onto the
   original. This is the same mechanism whether you hold write rights (staging
   your own edit) or not (suggesting one to someone else).

Everything below follows from those two sentences.

**The two words, kept apart** (the 2026-07-15 split). Earlier the fork concept
was called a "Draft", which overloaded the word and forced every draft to target
an existing resource. They are now distinct:

- A **Fork** is capability 2: a proposed change to an *existing* resource. It has
  a target resource (`originalSubject`) and a lifecycle of **merge**.
- A **Draft** is capability 1: unpublished *new* content. It is **not a class**,
  it is a *place* — a resource living in the drive's private Drafts folder. It has
  only a target *parent* and a lifecycle of **publish** (= move somewhere publicly
  readable). Nothing to add or strip; publishing a draft is an ordinary re-parent.

## 1. Visibility is location

Rights in `hierarchy.rs` are additive, and the `drive` fast path consults only
the `drive` propval — everything else resolves by walking parents. So a drive
that is **not** blanket-public can contain:

- a **public folder** carrying `read: [PUBLIC_AGENT]`, whose children inherit
  public read through the ordinary parent walk, and
- a **private folder** (no grant) whose children are visible to editors — who
  hold `write` on the drive — but not to the public.

Draft, published, and archived are therefore **three folders**, and publication
state is implied by where a resource *is* rather than by a label that has to be
kept in sync with reality. Publishing is a re-parent. So is archiving.

Pinned by `hierarchy.rs::a_public_folder_in_a_private_drive_publishes_only_its_own_children`.

**Prerequisite bug, fixed in `c61e1100`.** `drive` is a rights shortcut consulted
before the parent walk, but it was client-supplied and written only at genesis.
A resource moved between drives kept its old stamp and stayed readable under the
old drive's grants — so moving a resource out of a public drive did not make it
private. `commit.rs` now derives `drive` from `parent` at genesis and on every
move. Pinned by `hierarchy.rs::moving_a_resource_to_a_private_drive_revokes_public_read`.

**A `draftsOnly` marker on a folder** may later be worth adding as a **UI hint**
— so the UI knows a folder is a staging area and can offer Publish. It must carry
no authorization meaning. The moment a label rather than the ACL decides what is
public, the label and the boundary can disagree; that is precisely the trap the
original `status`-property proposal in #467 fell into.

## 2. A proposed change is a fork

| Term | Datatype | Meaning |
| --- | --- | --- |
| `Fork` (class) | — | Marker: this resource proposes a change to another. |
| `originalSubject` | atomicURL | The resource it proposes to change. |
| `forkBase` | json | The original's content propvals at fork time, for the three-way propval merge. |
| `forkVersion` | string | Base64 Loro version vector at fork time, for the CRDT body merge (only on forks of Loro-body classes). |

`originalSubject` is the term already spec'd in `docs/src/commits/suggestions.md`
("Fork", "Suggestion", "Controller", "Inbox"); we implement it rather than mint a
competing `target`.

A fork is a normal resource: it has its own subject, its own Loro doc, its own
commit history, and it can be collaboratively edited, commented on, and shared
like anything else. It carries the content class **alongside** `Fork`
(`isA: [BlogPost, Fork]`) so the normal views render it — no parallel preview
stack.

**Merging is a three-way squash.** A plain squash (write every draft propval onto
the original) has a silent data-loss bug: a property the draft never touched still
carries its fork-time value, so merging reverts any concurrent edit the original
received in the meantime. To avoid that, a fork records `forkBase` — the original's
content propvals at fork time, as a self-contained JSON snapshot (chosen over
replaying the forked-from commit, because commit retention is optional node policy
per `commit-retention-and-state-certificates.md` and a snapshot works on a pruned
or offline node). Merging (`diffFork` / `mergeFork` in `browser/lib/src/forks.ts`)
writes **only** the properties the draft changed relative to `forkBase`; a property
untouched by the draft is left alone. Where both sides changed the same property it
is a **conflict**, surfaced (`ForkChange.conflict`, count shown in the ForkBar,
`onConflict: 'throw'` to abort) rather than silently resolved.

Squash rather than importing the fork's Loro oplog *for propvals*, because an oplog
import lands every intermediate draft revision in the original's doc — permanently
and, once published, publicly reconstructible. Squash leaves draft history behind on
the fork where it stays private. It also needs no new commit semantics and stays
portable across the `Backend` seam `nextgraph-interop.md` wants.

**The body of a Loro-body class (DocumentV2) is a genuine CRDT merge, not a squash.**
A document's text lives in a Loro `doc` container that the propval diff cannot see, so
propval squash alone would lose every body edit. The fork therefore *seeds* the draft's
Loro doc from the original's (`seedLoroBodyFrom` — a snapshot import, so the draft's body
shares the original's causal history) and records `forkVersion`, the version vector at
fork time. Merging (`mergeLoroBodyFrom`) exports only the draft's ops *since* `forkVersion`
and imports that delta into the original — a real op-level merge, so a concurrent body edit
on the original and one on the draft both survive. This is scoped to the `doc` container:
seeding/merging a snapshot would clobber the original's propvals, so the merge snapshots
the original's propvals around the import and restores them, keeping the body merge (Loro)
and the propval merge (three-way) independent. Pinned by
`browser/lib/src/forks.test.ts` ("forks a document body and merges concurrent body edits
as a CRDT") and the `edit a document body as a fork` e2e.

Because the merge commit is an ordinary write to the original, **authorization needs
no changes at all**: `check_write` on the original already decides who may merge.

**Flow gaps still open** (the mechanism is safe, but the review flow is not complete):
- **Discovery — done for same-drive.** A `PendingForks` bar on the original runs a
  reverse query (`originalSubject == thisResource`, drive-scoped) and lists the forks
  proposing changes to it. This works because a same-drive fork rides ordinary drive
  sync into the reviewer's own replica, where a local query finds it — no inbox, no
  push. It only surfaces forks the reviewer can already read; a proposal on someone
  else's drive is invisible here **by design** and needs the cross-agent delivery
  primitive below.
- **Review/diff UI.** `diffFork` returns per-property base/draft/original + conflict;
  reuse the existing `components/ResourceDiff` to render it. The ForkBar only shows
  counts today.
- **Suggest-an-edit for non-writers.** `Edit as fork` is gated on `canWrite`, so the
  actor-side "propose a change to a resource you can't write" half of
  `docs/src/commits/suggestions.md` is unimplemented. Needs distributor mode (see
  Open questions) — scope separately.
- **Reject with reason.** Declining someone else's proposal is only `Discard` (destroy).
  A record/notification is missing.
- **DocumentV2 is supported; Canvas is not.** A document's body is a Loro `doc`
  container, now seeded on fork and CRDT-merged on merge (see "The body of a Loro-body
  class" above), so `Edit as fork` works on documents and the draft bar offers Merge on
  the strength of a body edit alone (`hasBody`, no changed propval). A Canvas keeps its
  content in Loro *stroke lists*, not the `doc` container the fork seeds, so forking one
  would silently lose the body — `Edit as fork` is gated off Canvas (and off Drive)
  until canvas grows its own fork/merge.

## What we are *not* doing, and why

Each was considered against the code, not on taste.

- **A `status` property gating visibility.** Presentation metadata, not a boundary:
  rights are per-resource and additive, so a label does not stop anyone `GET`ing the
  resource. Superseded by "visibility is location".
- **A deny / veto rule.** Would be the first subtractive rule in the model. Monotonic
  grants are what make authority verifiable offline — you prove a right by exhibiting
  a signed grant, whereas a deny requires proving the *absence* of something across
  replicas that may withhold it. Turned out to be unnecessary.
- **A `publishTo` property and draft-by-default creation.** Only needed if new content
  starts life as a special kind of resource. It doesn't: new content is just content,
  created wherever you create it. Creating a resource keeps behaving exactly as it does
  today.
- **Deferring class validation for drafts.** Only needed to let an incomplete
  `isA: [BlogPost, Fork]` post save. With new content being ordinary content, the real
  problem is that the website ontology marks `cover-image` and `published-at` as
  *required*, which is over-strict regardless of drafts. Fix the ontology, not core
  validation.
- **A draft as a stored-but-unapplied commit.** Commits carry a 10-second
  `validate_timestamp` window and `created_at` is inside the signed bytes, so a commit
  awaiting review is invalid by the time it is merged. Commits are also immutable and
  childless by design (`hierarchy.rs`: "Commits cannot be edited" / "cannot have
  children"), so a pending commit cannot carry a mutable status or review comments.
- **A draft as a Loro branch of the target's own doc.** A second lineage on one subject
  is exactly the divergence bug in `loro-source-of-truth.md`, where "every later commit
  re-merged two divergent branches as LWW — silently dropping writes at random". A fork
  must be a separate subject with its own doc.
- **Drafts on a separate private drive.** Unnecessary once the drive is not
  blanket-public, and it splits authoring tooling across two drives.

## Suggestions (edits without write rights)

A suggestion is a fork authored on the **suggester's own drive** — the actor-side
pattern `authorization-sync.md` prefers. No cross-drive grant is required: the
suggester writes only where they already can.

Constraints that document already fixes, which this design respects:

- Public `write` is rejected as a grant basis ("muddies authorship — do not accept").
  A suggestion is never an unapplied write on the target's ledger.
- Grants are additive and irrevocable, so **accepting a suggestion must not mean
  granting the suggester write**. It means the Controller signs the merge commit —
  which is exactly what squash-merge does.

Delivery/discovery is deliberately unresolved — see Open questions.

## UI

Lands in the actions registry (`browser/data-browser/src/actions/`, `planning/actions.md`),
so each verb appears in the context menu, ⌘K, ⌘M and the AI/MCP surface for free.

- **Edit as fork** — forks the resource. `available: canWrite`.
- **Suggest an edit** — the same fork, authored on your own drive. `available: !canWrite`.
  This is the "right-click any Atomic Data on the web and suggest an edit" verb from
  `docs/src/commits/suggestions.md`.
- **Merge fork** — squash onto `originalSubject`. `available: isDraft && canWrite(original)`.
- **Discard draft**.
- **Publish / Unpublish / Archive** for plain content — a *move* into or out of the public
  folder. Generic; nothing website-specific.
- A resource with pending drafts shows them (each draft names its `originalSubject`, so the
  reverse lookup is a plain query — no back-reference property needed).

## Website template consequences

- Grant `read: [PUBLIC_AGENT]` on the **site folder**, not on the drive.
  `makeDrivePublic()` in the e2e helpers becomes a folder-level grant.
- Ship a `Drafts` folder (private) next to the public site folder.
- Loosen the over-strict `requires` on `blogpost` (`cover-image`, `published-at`) so an
  incomplete post is saveable anywhere.
  **Done (2026-08-14):** both are `recommends`. Generated sites treat a missing
  `published-at` as unpublished.
- Generated queries must exclude `Fork` and stop rendering future-dated posts. Today
  `published-at` is used only for sorting and display, so a post dated 2099 renders now.
  **Done (2026-08-14) for generated sites:** listings, search, and path lookup skip
  forks and unpublished posts. Drive-level public read is unchanged.
- E2E: a draft is invisible to an anonymous visitor of the generated site, and visible
  after publish.

## Known gap: seeding a new default ontology into existing stores

`bootstrap()` is guarded by `has_stored_resource(SHORTNAME)`, so a store that was
already populated never picks up a newly-added `lib/defaults/*.json`. That applies
to **both** ends:

- **Server:** needs `--repopulate-defaults` (or a fresh store) to learn `Fork` /
  `originalSubject`. Without it, a commit carrying `isA: [.., Fork]` is rejected
  with *"Failed getting class .../Fork … 404"*.
- **Browser:** the WASM ClientDb embeds the same defaults, so it needs a rebuilt
  wasm bundle *and* a store that repopulates. An existing client silently falls
  back to fetching `https://atomicdata.dev/properties/originalSubject` over the
  network, which 404s — validation is then skipped for that property.

Verified in the running app: on a fresh server store + fresh browser store the
whole fork → edit → merge loop works, and the draft is correctly *not* publicly
readable. On stale stores it fails in the two ways above.

This is not specific to drafts — it is how *any* new default ontology reaches
existing deployments, and it needs a migration story (version the bootstrap, or
import missing defaults idempotently on boot) before this ships.

## Open questions

- **Where does a fork live by default?** The drive's `Drafts` folder when the author can
  append there, otherwise their personal drive. Needs a single predictable rule, not a
  heuristic per surface.
- **Suggestion delivery.** Indexer-built reverse index ("who suggested edits to X") vs. an
  append-only inbox on the target. `authorization-sync.md` prefers the former and explicitly
  *reserves* the inbox primitive for first-contact DMs, service notifications, and protocol
  bridges; a suggestions inbox would be a fourth case and must argue for itself.
- **Inbox items are editable after delivery.** `authorization-sync.md` asserts senders
  "cannot mutate existing inbox items", but a sender is the genesis signer of their own item
  and therefore has implicit creator-write. If suggestions ever land in an inbox, close this
  first.
- **Cross-agent suggestions need distributor mode**, not the hub-mediated trust mode that
  ships today. Same-drive drafts do not — which is why drafts ship first.
- **Canvas body merge.** DocumentV2's `doc` container is CRDT-merged; Canvas's stroke lists
  are not yet forked/merged, so `Edit as fork` is gated off Canvas. Extending the
  seed/merge to stroke containers is the remaining Loro-body case.
