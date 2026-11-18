# Legacy schema review content separation

Keep baseline code moves separate from behavioral proposals, without expanding
the clean extraction or changing ELFA's pin. These are legacy review bases and
still need later clean-base integration.

- [x] Identify input/focus, persistence and range-validation changes.
- [x] Relocate baseline presentation and helpers without fixing old policies.
- [x] Run focused package/real Atomic compatibility tests, compiler/types, real
  component desktop/mobile captures and the mandatory commit hook.
- [x] Preserve original heads and all child review bases before rewriting refs.
- [ ] Publish separate proposed-behavior reviews; preserve the original result.

Explicit text-format save removal is disputed under #2538. Raw range semantics
and submit validation require their own review, not an extraction prerequisite.
