# Drive as a Git repository

> Status: **Exploration + prototype (2026-08-16).** Prototype lives in
> `lib/src/git_export.rs` (snapshot export of a drive to a working tree, optional
> `git init` + commit, and a lossy re-import). Not a sync replacement and not a
> substitute for the encrypted vault.

Related: [`virtual-drive.md`](./virtual-drive.md) (OS filesystem mount),
[`encrypted-vault-format.md`](./encrypted-vault-format.md) (blind backup),
[`importers.md`](./importers.md) (getting foreign trees *in*),
[`commits/compare.md`](../docs/src/commits/compare.md) (Atomic commits vs Git),
the stub at [`docs/src/interoperability/git.md`](../docs/src/interoperability/git.md).

## Why this is more interesting than a filesystem mount

The virtual drive already answers "make the hierarchy look like folders and
files." A git repo is that projection **plus** four things the mount cannot
give you:

1. **A portable backup** you can `git push` to GitHub / GitLab / a USB stick
   without running Atomic. Vault backup is better as a *blind, complete*
   restore; a git export is better as a *readable, standard* copy.
2. **Compatibility.** Other tools already speak git + markdown + binary files:
   editors, static-site generators, review UIs, `git diff`, `git grep`,
   GitHub search, LLM coding agents. The VFS is only useful while Atomic is
   running.
3. **Human history.** GitHub PRs, blame, and tags are a collaboration surface
   Atomic does not have. Mapping *into* that surface is a product, not just an
   export format.
4. **An interchange format.** "Here's my drive as a repo" is something you can
   email, fork, and (lossy) import back. The VFS is a live view; git is a
   document.

They compose: the VFS *is* the working tree a git adapter would watch. The
mapping work in `desktop/src/vfs.rs` (sanitize names, File → bytes, Folder →
dir, everything else → stub) is the first half of this design. Git is the
second half: persist that tree, give it history, make it round-trip.

## What it is not

| Existing thing | Job | Git export's job |
| --- | --- | --- |
| Encrypted vault | Blind, complete, identity-preserving backup of CRDT history + blobs | Readable projection of *current state* |
| VFS / NFS mount | Live OS integration, editors write commits | Offline / pushable copy |
| Iroh / WS sync | Multi-device CRDT merge, ACLs, presence | None of that |
| Loro oplog | Per-resource, conflict-free, op-granular history | Whole-tree snapshots, 3-way merge |

A git repo of a drive is a **projection**, not a replica. Re-importing it
cannot recreate the same DIDs unless the export also carries genesis
certificates and signatures (see [Identity](#identity-paths-are-not-dids)).
Treat it as backup-of-content and as interchange, not as the source of truth.

## Mapping: the working tree

The prototype writes this layout (v1 of `atomic-git-export`):

```text
<repo>/
  README.md                         # drive name + pointer at the format
  .gitignore
  .atomic/
    FORMAT.md                       # this layout, versioned
    drive.json                      # drive resource as pretty JSON-AD
    index.json                      # DID → path + kind (the load-bearing map)
    resources/<did_sanitized>.json  # full JSON-AD minus Loro binary
    loro/<did_sanitized>.bin        # optional: raw Loro snapshots
  Notes/
    Hello.md                        # DocumentV2 body as markdown
  Photos/
    cat.jpg                         # File blob bytes
  Projects/
    Roadmap.json                    # any other resource as JSON-AD
```

Class → file:

| Atomic class | Git path | Content |
| --- | --- | --- |
| Drive | repo root | `.atomic/drive.json` |
| Folder | directory | children + JSON-AD under `.atomic/resources/` |
| File | basename from `filename` / `name` | blob bytes (chunked files concatenated) |
| DocumentV2 | `{name}.md` (or `index.md` inside the folder if it has children) | markdown extracted from the Loro/ProseMirror body, else `description` |
| Table, ChatRoom, anything with children | directory | children as files; self as JSON-AD |
| Everything else | `{name}.json` | pretty JSON-AD, keys sorted |

Filename sanitization is the same load-bearing table as
[`virtual-drive.md`](./virtual-drive.md#filename-sanitization): no `/`, `\`,
NUL, `..`, bidi overrides; collisions get ` (2)`, ` (3)`. Applied only at the
materialization boundary — the canonical `name` in Atomic is unchanged.

JSON-AD in `.atomic/resources/` **omits** `loroUpdate`. The binary snapshot is
not a diff-friendly file; stuffing base64 into JSON would dominate every
commit. Optional `.atomic/loro/*.bin` is the escape hatch for a more complete
backup.

## Identity: paths are not DIDs

Git's unit of identity is a path. Atomic's is `did:ad:{genesis}`. Those
disagree on the operations people actually do:

- **Rename** in Atomic is a property change; in git it is `git mv` (detected
  heuristically). `.atomic/index.json` is the stable DID → path map so an
  importer does not mint a new resource because a markdown file moved.
- **Move across folders** is `parent` in Atomic, a path change in git. Same map.
- **Two resources, same name** is legal in Atomic, illegal as sibling files.
  Collision suffixing is required, and the suffix must be stable across
  re-exports (prototype: first-wins order from the parent index, then
  `(2)`… — not a hash of the DID, so a rename of the *other* file does not
  reshuffle numbers). Follow-up: suffix a short DID stem when colliding so
  identity is obvious in the path.
- **Delete** in Atomic is a tombstone + optional commit retention; in git it is
  an absent path. Re-import must not resurrect a tombstoned DID.

Round-trip that **preserves DIDs** needs the genesis certificate (and, for a
verifier, the signature chain) in the sidecar. The prototype stores JSON-AD
propvals including `genesis` when present, but re-import currently *mints new
DIDs* under the target drive. That is the honest v1: content compatibility,
not identity restore. Vault remains the identity-preserving backup.

## History: three levels, only the first is real today

Atomic history is per-resource Loro oplogs plus signed commits. Git history is
a DAG of whole-tree snapshots. There is no 1:1.

### Level 0 — snapshot (prototype)

Current drive state → working tree → one git commit. Re-running the export on
the same repo is `git add -A && git commit` if anything changed. This is a
backup strategy: cron it, push to a remote. Authors of the git commit are the
exporting agent, not the original editors.

### Level 1 — replay Atomic commits as git commits

Order every stored Commit on the drive by `createdAt`, apply to a working tree,
commit in git with:

- `GIT_AUTHOR_DATE` = `createdAt`
- author name = agent `name` (fallback: public key)
- author email = `{pubkey}@atomic.invalid` (stable, not a real inbox)
- message = first line of changed resource names, plus the commit DID

Problems this immediately hits:

- Commits are **per resource**. A user saving a doc and a table in one "mental
  save" is two (or twenty) Atomic commits and would become twenty git commits
  unless we coalesce on a time window. The VFS already coalesces writes at
  500 ms for this reason; a history exporter should too.
- Loro concurrent edits are **not** a git merge. Two agents editing one
  document produce one merged Loro doc and two signed commits. Replaying in
  `createdAt` order gives a linear git history that never shows the branch.
  That is fine for blame-ish "who touched this file," wrong for "recreate the
  CRDT merge."
- Binary files are LWW in git and in Atomic. Conflicted-copy naming from the
  VFS plan still applies if we ever watch a git remote for incoming commits.

Worth building after snapshot export is used as a backup, because the author
/ date mapping is what makes GitHub history feel like Atomic history.

### Level 2 — git as a live replica (do not start here)

Watch the working tree (or a bare remote) and produce Atomic commits; watch
Atomic and produce git commits. Echo suppression is the same problem the VFS
already solved (`connection_id` / source-id). The new problems are worse:

- Git merge ≠ Loro merge. A GitHub PR merge of two markdown files will not
  match two agents typing in TipTap. You either (a) treat git as LWW on the
  markdown projection and accept that the Loro oplog and the file diverge, or
  (b) refuse git merges and only allow fast-forwards, which kills the
  "collaborate on GitHub" pitch.
- ACLs have no git equivalent. A private folder in a public GitHub repo is a
  leak. Encrypted git (`git-crypt`, age, the vault format) is a different
  product; the readable export is for drives the user is willing to publish
  or keep in a private remote.
- Path identity vs DID identity, every time someone `git mv`s.

Recommendation: **do not** make git a sync transport. Make it an export
target and, later, a one-way "publish this drive as a website / public
archive." Two-way belongs to Iroh/WS. If someone wants git-style PRs on Atomic
data, that is the Fork class in [`drafts-and-suggestions.md`](./drafts-and-suggestions.md),
not `git merge`.

## Documents as markdown

This is the compatibility win. A DocumentV2 whose body is a Loro-ProseMirror
tree becomes a `.md` file other tools can open.

The conversion is **lossy in both directions**:

- TipTap marks that are not markdown (colors, mentions, inline comments,
  canvas embeds) flatten or drop.
- Markdown imported back cannot reconstruct the original CRDT items, so
  collaborators who kept editing in Atomic will conflict with a naive
  overwrite. Import should write a *new* Loro doc from the markdown, not
  splice into the old one, unless we are doing a deliberate "replace body"
  user action.

The prototype extracts:

1. Loro `doc` map → markdown (headings, lists, code, quotes, links, emphasis)
2. else `documentContent` text container
3. else the resource's `description`

Search already uses (1)/(2) as plain text
(`AtomicLoroDoc::extract_document_plain_text`). Markdown is the same tree with
structure kept.

## Blobs

File resources write their bytes at the human path. Chunked files
(`chunks`) are concatenated, matching the VFS read path. Git then
delta-compresses them — poorly, for already-compressed media.

Follow-ups, not v1:

- **Git LFS** for files over a threshold (reuse `CHUNK_THRESHOLD` / FastCDC
  thinking). Pointer files stay in git; bytes go to LFS storage. Maps cleanly
  onto `did:ad:blob:{blake3}` if we ever teach LFS to use BLAKE3 keys.
- **Skip blobs** (`include_blobs: false`) for a metadata-only export: useful
  as a catalog / sitemap, useless as a backup.
- **Symlink to a CAS dir** so two File resources with the same blob don't
  duplicate bytes in the working tree. Git will still store one blob object.

## Backup strategy (how this sits next to the vault)

Use **both**, for different threats:

- **Vault** — device lost, attacker has the backup host, need a complete
  restore of DIDs + history + blobs, encrypted. This is "I still have my
  identity."
- **Git export** — "I want a readable copy on GitHub / a disk I already
  understand." Also the off-ramp: if Atomic disappeared tomorrow, the markdown
  and files would still be a website. Also the on-ramp: a folder of markdown
  can be imported as a drive.

A scheduled "export this drive and `git push`" is a legitimate product
feature (desktop or server). It should warn that private drives must use a
private remote, and that this is not encrypted at rest.

## Prototype (what shipped)

`atomic_lib::git_export`, gated on the `db` feature:

- `export_drive(store, drive, dest, opts)` — walks `parent` like
  `collect_drive_subjects`, writes the layout above, optionally `git init` +
  commit (shells out to `git`; no libgit2).
- `import_as_new_drive(store, src)` — reads `index.json` + files, mints a new
  drive and new DIDs. Lossy, identity not preserved. Proves the tree is
  loadable.
- `cargo run -p atomic_lib --features db-redb --example export_drive_git -- <dir>`
  — builds a sample drive (folder, document, file, bookmark) and exports it.

Out of scope for the prototype: commit replay, LFS, watching a remote, ACL
filtering of the export (it dumps everything the local node can read; callers
must pass a store already scoped), encrypted remotes.

## Open questions

- **Default to markdown+sidecars, or JSON-AD-only?** Markdown is the
  compatibility story; JSON-AD-only is the faithful one. v1 does both
  (projection + sidecar). A `--faithful` flag that writes only JSON-AD would
  be a small add if someone wants a byte-stable archive without extraction.
- **Should re-export into an existing repo preserve manual edits?** If a user
  edits `Hello.md` in git and we re-export from Atomic, we clobber them
  unless we merge. v1 clobbers (Atomic is source). A publish pipeline that
  treats git as downstream is the intended use; a two-way working copy is
  Level 2 and rejected above.
- **Tables as CSV.** Rows-as-JSON-in-a-folder diffs; CSV diffs better in
  GitHub and opens in Excel. Needs shortname headers and a stable column
  order (class schema). Not in v1.
- **Where does the exporter live?** Library is right (tests, desktop, server
  cron, CLI). A later `atomic-cli export-git` and a desktop "Export to folder"
  are UI, not new mapping.
- **Share the path mapper with the VFS.** `sanitize_name`, display-name,
  collision suffixing, blob read, and "is this a directory" are duplicated
  with `desktop/src/vfs.rs`. A `lib/src/fs_map.rs` (the `VfsBackend` trait the
  VFS plan already wants) should own them before either grows further.

## Suggested next slices (not this prototype)

1. Share `fs_map` with the VFS (sanitize + display name + blob read).
2. `atomic-cli export-git --drive … --out …` against a local `Db`.
3. Level 1 history replay, coalesced on a quiet window, as an opt-in
   `--history` on the same exporter.
4. Table → CSV using the class's recommended properties as columns.
5. DID-preserving import: require `genesis` in the sidecar, verify, refuse if
   missing — and document that this is still not a vault restore (no oplog).
