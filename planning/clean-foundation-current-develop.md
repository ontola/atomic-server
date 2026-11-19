# Clean shared UI/table foundation on current develop

This review vehicle has one parent: develop `9e9017e`. Its extraction tree comes
from `78786e742` (the #2597 foundation before generic hosted/Dagger CI commit
`a58544dcd`), reconciled with every change already on develop. It does not use a
historical plugin candidate or the improved full-page candidate tree.

Source inventory:

- `2ba5ce1a0`: #2535 canonical shared UI and compatibility exports.
- `060460eb4`: #2536 grid/editor extraction and pure helpers.
- `cc4434fbb`: build extracted dependencies in fresh integration entrypoints.
- `5aa9cc409`, `cbaa6c1f1`: review inventory and closure documentation.
- `bd4fa0ed5`: clean move batch #2539, #2541, #2545, #2547, #2549, #2551,
  #2553, #2556, reconciling additive exports and compatibility types.
- `7d9cace65`: compiler regression reads canonical Button implementation.
- `78786e742`: prior validation and remaining integration gates.

Reconciliation had seven conflicts: package scripts and six catalog tails.
The main build retains develop's cross-platform `scripts/build.mjs`; Tauri
preparation retains extraction's dependency-closure build. Catalogs retain both
extraction labels and develop's new Vault/secret translations. Catalog extraction
remains a fixed-point validation gate.

Develop runtime/storage implementation is preserved. SDK moves are EventManager
and calendar-date into `@tomic/utils`, retaining compatibility exports. No
persistence guarantee, receipt, IAP, legacy plugin baseline, state controller,
retry/conflict fix or component improvement is added. Existing plugin dependencies
already on develop remain as they were.

Complete TablePage (#2595) stacks separately, as do component improvements.
Extraction build wiring/package CI lanes remain; generic hosted/Dagger redesign
and later workflow consolidation are separate.

Structural auditing found 47 canonical modules with identical TypeScript
statement bodies after excluding comments, imports and re-exports. Other modules
contain extraction seams (host callbacks, theming, combined codecs and component
splits); this is not blanket byte equivalence. Mapping/seam inventory is recorded
in task artifact `clean-foundation-move-audit.json`.

Report validation on the final vehicle commit. Historical checks in the existing
plans apply only to their original source heads.

Bounded extraction repair: Wuchale's original `src/**` include missed canonical
UI/table modules after their move. Added `../ui/src/**` and `../table/src/**`,
retaining declaration/test exclusions. Without those paths, a clean extraction
cannot track moved labels (including dropdown actions and action form labels).
Two clean extraction runs are checked for identical catalog hashes. Catalog audit
compares every develop message/plural and every nonempty translation; moved
entries retain their translations, including four pre-existing keys the legacy
batch had dropped. No external translator is used. A generated French-catalog
React render of shared UI/table labels produces “Filtrer les actions” and “Effet”
without missing-message markers (task artifact `foundation-localized-smoke.html`).

Current local checks: own pure-helper/shared-UI TypeScript builds and all 39 table
package tests pass. Fresh package tests initially failed to resolve unbuilt UI
distribution, then passed after building those actual dependencies. No WASM or
full application build has been borrowed or run for this source vehicle.
