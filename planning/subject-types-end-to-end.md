# Subject types end-to-end

> Status: planned 2026-05-28. Correctness. Invasive.

## Problem

The codebase has two notions of "subject":

- Rust: `atomic_lib::Subject` — a newtype wrapper that validates
  shape (must be `did:ad:...` or `http(s)://...`).
- TS: `string` everywhere.

This caused real bugs in this session:

- `ws_drive_membership` test compared `Subject == &str` and failed
  silently until I added `.as_str()`. The Rust type system would
  have caught it; the symmetric TS bug wouldn't.
- Outbox `entry.subject` is a `string`, server-side `Commit.subject`
  is a `Subject` — round-trip through JSON-AD loses the invariant.
  Stuck genesis commits exploited this: the server's "this subject
  exists" check used the validated form, the client's "should retry"
  used the raw string, so the retry loop never saw the mismatch.

## Symptom (latent)

The codebase trusts subject strings to be well-formed in many places
that don't validate. Some failure modes:

- A subject with a trailing slash compares unequal to one without —
  causes subscription misses.
- A subject that's actually a Property URL gets sent as a Commit
  target — server returns 400, client retries forever (before the
  outbox terminal-error fix this session).
- DID subjects (`did:ad:...`) vs HTTPS subjects need different
  routing — done ad-hoc with `startsWith('did:')`.

## Proposal

Introduce a TS `Subject` branded type that mirrors the Rust shape:

```ts
// browser/lib/src/subject.ts
declare const SubjectBrand: unique symbol;
export type Subject = string & { [SubjectBrand]: true };

export function asSubject(s: string): Subject {
  if (!s.startsWith('did:ad:') && !/^https?:\/\//.test(s)) {
    throw new Error(`Invalid subject: ${s}`);
  }
  return s as Subject;
}

export function isDidSubject(s: Subject): boolean {
  return s.startsWith('did:ad:');
}
```

Migrate signatures incrementally:

- `Resource.subject: Subject`
- `store.fetchResourceFromServer(subject: Subject)`
- `OutboxEntry.subject: Subject`
- WS protocol decoders return `Subject`
- ...etc.

Validation happens at the boundaries (decoder inputs, user-typed URL
bars). The rest of the code treats `Subject` as opaque.

## Why this is hard

- Lots of `string` call-sites. Codemod can do 80%; the rest are
  judgement calls (some "subjects" are actually property URLs, etc).
- Brand types interact badly with `JSON.parse` — every parsed string
  needs explicit casting.
- The Rust `Subject` already exists; this matches it, but the JSON-AD
  wire format doesn't tag what's a subject vs. a property vs. a
  string value. Decoders need to know.

## Risk

- High blast radius (touches every file that handles subjects).
- Low semantic risk (only adds compile-time checks, no runtime
  behavior change beyond the validating constructor).

## Effort

- 1 day for the type + helpers + first wave of consumers.
- 1–2 weeks of incremental migration.

## Concrete steps

1. Add `Subject` brand + `asSubject` constructor.
2. Change `Resource.subject` typing first (highest-leverage).
3. Let the compiler tell you where to cast/validate.
4. Add a lint rule: no `string` for parameters named `subject`,
   `parent`, `drive`.
