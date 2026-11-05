# Table workspace package

Status: first extraction under review; full TablePage extraction remains open.

- [x] Isolate grid, context and primitive editors in `browser/table`.
- [x] Retain Data Browser loading/control-lock/formatting adapters.
- [x] Support local source imports and built ESM/declarations from one API.
- [x] Include the package in lockstep version checks and npm release builds.
- [x] Validate a packed external consumer and carry the package pin into ELFA.
- [x] Add an independent package CI lane with a clean packed-consumer check.
- [ ] Extract the larger schema/view/query host contracts in later slices.
- [ ] Configure the npm Trusted Publisher before the first registry release.

Keep queries, persistence, permissions and router ownership with the host. The
grid package is the first increment of the full port, not a claim that moving
TablePage's files makes its Atomic Resource/Store contracts storage-independent.
