# Cross-language test vectors

Shared fixtures that pin behavior across the TypeScript and Rust implementations.

## `frozen.json`

The `did:ad:frozen` content-addressing contract. Each vector is a JSON-AD `body`
and its expected frozen `id` = `did:ad:frozen:` + `blake3(JCS(body))`, where JCS
is RFC 8785.

Both sides must reproduce the same `id` from the same `body`:

- TypeScript: `browser/lib/src/frozen-vectors.test.ts` asserts `frozenIdFor(body) === id`.
- Rust: `lib/src/frozen.rs` tests assert `frozen_id(body) == id`.

If you change the canonicalization or hashing on either side, regenerate the
vectors and confirm both suites pass — a diff here is a cross-language identity
break.
