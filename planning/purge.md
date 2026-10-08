# Purge: erase a resource and all traces of it (#2155)

Status: **Built (server and `atomic_lib`).** Open: browser clients (TS `CommitBuilder`
has no `purge`; the WASM store applies a received purge through the same
`apply_commit`), a UI, and a CLI `scrub` subcommand.

## Why

Destroy removes the current state and keeps proofs on purpose (the destroy
envelope, genesis rows, content-addressed blobs). GDPR erasure needs the
opposite. See [`auditability-loro-history.md`](./auditability-loro-history.md)
(envelopes) and [`s3-blob-storage.md`](./s3-blob-storage.md) (blobs).

## Design

A purge is a signed commit with `destroy: true` and `purge: true`
(`urls::PURGE`, in `default_store.json`). It travels the destroy path
everywhere: `POST /commit`, WS `COMMIT`, `DbEvent::Destroyed.commit_json`,
`SYNC_DIFF.removeCommits`, `apply_peer_remove`. No new endpoint, no new frame.

- **Shape** (`Commit::validate_and_build_response`): needs `destroy`, no
  `loroUpdate` (`CommitBuilder::sign` skips the snapshot a plain destroy
  carries), and the resource must exist locally.
- **Right** (`hierarchy::check_purge`, on top of `check_write`): Sudo, the
  node's own agent, an agent purging itself, or an agent explicitly in the
  `write` list of the drive root. Replicas run the same check against their
  copy of the drive. Chosen for being checkable offline from replicated state
  and strictly stronger than `write`.
- **Erased in the apply transaction** (`Db::queue_purge`, called from
  `apply_commit` after `recursive_remove`, so the cascade is covered): the
  resource and snapshot (existing), every `Tree::Envelopes` row of each removed
  subject, every `did:ad:`/`atomic:` commit row about them (found by scanning
  the commit rows, because genesis rows are deliberately not indexed) with
  their index rows, outbox entries, and the trigram dictionary entries of
  terms no remaining document uses (`search::purge_orphan_trigrams`).
- **Kept**: the purge commit row and its envelope (`envelopes::record_ops`
  writes only this one for a purge), the `tombstone:` marker. They hold no
  values. The subject stays; use opaque subjects for personal data.
- **Blobs**: hashes are read from `internalId` / `blob` / `chunks` before the
  removal. After the transaction, `Db::purge_unreferenced_blobs` deletes each
  one for which `blob_referrers(hash, Sudo)` (the lookup behind
  `readable_blob_referrers`) is empty. `BlobBackend::delete` is new (S3 too).
  A `purge-blob:<hash>` marker in `Tree::PluginMeta`, written in the same
  transaction, makes this crash safe; `resume_pending_blob_purges` runs at
  server start.
- **Peers**: a replica that holds the resource applies the tombstone like a
  destroy and purges its copy. A replica that does not hold the resource
  refuses it (nobody to authorize), which is fine: it has nothing to erase.
- **Disk**: redb does not zero freed pages and `Database::compact` leaves the
  freed pages below the new end of the file untouched (measured in
  `lib/tests/purge.rs`: the old values and the blob bytes were still in the
  file after a purge, and after compaction). So a purge writes
  `<store>/compact-after-purge`; the next start runs `redb_store::scrub_file`
  (copy live rows into a new file, zero the old one, rename) before serving.
  Between purge and restart the bytes remain in free pages.

## Cost

Nothing on the normal commit or read path changes: `purge` is `None` there and
every purge branch is behind `commit.purge == Some(true)`. A purge itself is
linear in the number of commit rows (one prefix scan) and in the search term
dictionary (one pass over `Tree::SearchTrigrams`, then up to three posting
lookups per distinct term). The scrub on restart is linear in the database.

## Residue that remains (by design or by limit)

- Free pages in the database file until the node restarts.
- Copy-on-write filesystems, volume snapshots, SSD wear levelling, backups and
  Vault packs made before the purge, and replicas that were offline (they erase
  on the next reconcile).
- The subject (and, for `files/<hash>` subjects, the content hash) in the
  tombstone; `DidMapping` routing hint; log lines.
- Other resources that link to the purged one keep the link value, not the
  purged data.
- Race: a File created for the same bytes between the referrer lookup and the
  blob delete loses its content.

## Not done

- Oplog compaction while the resource lives (issue: optional, skipped).
- Browser/TS client: `CommitBuilder.setPurge`, UI, and purging OPFS free pages
  (the WASM store applies the purge, but OPFS has no scrub step).
- Purge of a resource that was already destroyed (no resource to authorize
  from); a Sudo-only sweep could reuse `queue_purge`.
- `atomic-server scrub` CLI (the restart path exists).
