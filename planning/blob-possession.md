# Blob access: proof of possession (#2157)

A blob hash is not a capability. `internalId`, `blob` and `chunks` are plain
properties any writer can set, so "a readable resource references the hash"
cannot be the whole rule: an attacker who knows a hash would create a File of
their own naming it and download another user's private bytes.

## Rule

`Db::readable_blob_referrers(hash, agent)` counts a referrer only if

1. `agent` can read it (query rights, as before), and
2. its drive holds a claim `(hash, drive)`: `drive_holds_blob`, one point read
   per readable referrer, no scan.

The by-subject route (`/download/<file>`) applies the same check to the File
itself (`Db::resource_holds_its_blobs`), since a forged File can also be
downloaded directly.

Claims live in `Tree::PluginMeta` as `blob-claim:<hash>:<drive pure id>` with an
empty value. They are not resources: no API, no commit, no sync. The drive is
the `drive` stamp (commit application derives it from `parent`, so a writer
cannot aim a File at another drive), else the top of the `parent` chain (server
uploads are `internal:/files/<hash>` without a stamp). Stored rows only, no Loro
decode.

## Who writes a claim

| Path | Claim for |
| --- | --- |
| `POST /upload` (authenticated, write on parent) | the parent's drive |
| `PUT /blob/<hash>` signed (v2) | every admitted referrer drive where the signer may write the referencing resource |
| `PUT /blob/<hash>` unsigned (legacy) | the single admitted referrer drive; none if several drives reference the hash |
| sync `BLOB_RESPONSE` for a pending request | the drive the request was issued for |
| Server internals (plugin releases, website assets, image renditions) | none: read through their own routes, never through referrers |

Sync also requests bytes it already holds when the pushed File's drive has no
claim yet, so a pushed File cannot unlock a stored hash; the peer must send the
bytes.

## Migration

`Db::backfill_blob_claims` runs once in `Db::open` (marker
`blob-claims-backfilled:v1`): every stored resource referencing a blob claims it
for its drive. Existing installations keep all files. Anything forged before the
upgrade is indistinguishable from legitimate data and is also trusted.

## Residual risks

- A writer of a drive can reference any hash that drive holds.
- Unsigned `PUT /blob` is only safe when one drive references the hash. The web
  client signs the request; older clients fall back to the single-drive rule.
- Chunk blobs only get claims when their bytes arrive by one of the paths above.
- The Rust sync pull does not request blobs referenced only through `chunks`.
- Backfill trusts the pre-upgrade store.
