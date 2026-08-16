{{#title Atomic Data and Git}}
# Atomic Data and Git

Git is a snapshot DAG over a folder of files. Atomic Data is a graph of
resources, each with a Loro CRDT document and signed commits. They overlap
enough that **exporting a drive as a git repository** is useful — as a readable
backup, and as an interchange format other tools already speak — but they are
not the same model, and git should not replace Atomic sync.

A longer design note lives in [`planning/drive-as-git.md`](../../planning/drive-as-git.md).
A prototype exporter lives in `atomic_lib::git_export`.

## Similarities

- Both identify versions with hashes and can store history in a DAG.
- Both work offline-first and copy between machines without a vendor.
- Both can sign commits (git optional; Atomic always).
- Most user-facing Atomic data *can* be projected as files in folders, which is
  what git is good at.

## Differences

| | Git | Atomic |
| --- | --- | --- |
| Identity | Path in a tree | `did:ad:{genesis}` |
| Merge | 3-way, line-oriented, conflicts | Loro CRDT, automatic |
| Unit of change | Whole-tree snapshot | Per-resource signed commit + Loro update |
| Schema / ACLs | None | Classes, datatypes, read/write/append |
| History | Linearized snapshots | Per-document oplog |

Git does not validate structured data. Atomic commits do. GitHub-style
collaboration (PRs, blame) is a reason to *project into* git, not to store
Atomic state *as* git.

## Exporting a drive as a git repo

`atomic_lib::git_export::export_drive` writes an `atomic-git-export` v1 tree:

- Folders stay folders; File blobs stay files; DocumentV2 bodies become
  markdown; other resources become pretty JSON-AD.
- `.atomic/index.json` maps each DID to its path (paths are not identity).
- `.atomic/resources/` holds JSON-AD without the Loro binary.
- Optionally `git init` and one snapshot commit.

Re-import (`import_as_new_drive`) mints **new** DIDs. It is interchange, not a
restore of identity. Encrypted vault backup is the identity-preserving path.

Try the sample:

```sh
cargo run -p atomic_lib --features db-redb --example export_drive_git -- /tmp/atomic-drive-git
```

## When to use which backup

- **Encrypted vault** — complete, blind restore of CRDT history, blobs, and
  DIDs.
- **Git export** — readable copy you can push to a private remote, grep, or
  open in another editor. Not encrypted. Not a replica.
- **Virtual drive (NFS)** — live OS mount while Atomic is running.

## Live two-way sync with git

Not recommended as a sync transport. Git merge is not Loro merge; ACLs have no
git equivalent; a public remote of a private drive is a leak. Two-way
collaboration belongs to Iroh / WebSocket sync. Git is an export target and a
publish format.

If you want proposal/review workflows on Atomic data, that is the Fork class
(see the drafts/suggestions plan), not `git merge`.
