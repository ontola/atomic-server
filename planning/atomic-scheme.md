# `atomic:` identifier scheme (#1584)

**Status:** Implemented. Canonical scheme is `atomic:`; `did:ad:` is accepted forever.

Decided in https://github.com/ontola/atomic-server/issues/1584 (comment 2026-09-20):

- Resources stay bare: `atomic:{genesis}`.
- Kinds stay explicit: `atomic:agent:`, `atomic:commit:`, `atomic:blob:`, `atomic:node:`.
- No `open` / `pair` / `app` reserved words. A node identifier with query hints is a pairing code (`atomic:node:{id}?v=1&drives=*`); anything else navigates.
- Opaque form (no `//`). Legacy `atomic://pair` and `atomic://open` still parse.
- Genesis certificate **v2** (0x02) marks certs whose parent/drive strings were serialized in `atomic:` form. v1 stays for existing certs and the deterministic personal-drive singleton. The issue comment called this "v3"; the current format is v1, so the next byte is v2.
- Parsers accept both prefixes forever and canonicalize to `atomic:` at the store boundary (`pure_id()`, JS `normalizeSubject`). Verification uses signed bytes as stored.
- Vocabulary URLs stay `https://atomicdata.dev/…`. `internal:/path` stays.
- `/resource?subject=` is the endpoint; `/atomic` and `/did` remain aliases.
- Loro origin `atomic:system` → `origin:system` (still exclude the old prefix). Plugin localIds → `plugin:…`.
- Sync advertises `canonical-scheme`. A peer that does not list it receives `did:ad:` subjects on the wire.

Identity is the genesis/commit signature bytes, not the string prefix: `atomic:{x}` and `did:ad:{x}` are the same resource.
