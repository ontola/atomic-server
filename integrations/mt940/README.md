# Bank statements (MT940 and camt.053)

Open Integrations → Bank statements → Set up connection. Choose an MT940 or
camt.053 (ISO 20022 XML) file, preview, and approve. The format is detected
from the file contents: XML is read as camt.053, anything else as MT940. Reopen the installed Bank statements importer for later
files. A Bank transactions table lives beneath the importer; rows live beneath
that table. Shared banking terms live in the drive ontology.

bunq exports: bank account → Settings → Export statement → MT940.
https://help.bunq.com/en-ie/articles/how-do-i-export-a-bank-statement

## Architecture

`plugin.ts` bundles both readers (`parser.ts` for MT940, `camt053.ts` for
camt.053, dispatched by `statement.ts`) and the mapping into `plugin.js`. The
sandbox has no DOMParser, so `camt053.ts` carries a small namespace-agnostic
XML reader of its own. File acquisition is UI code. Parsing first runs in an isolated browser Worker; proposal generation
runs in the server QuickJS/WASM host, which supplies scoped query/read access.
No network operations or secrets are declared. File contents are runtime input,
not plugin source. Proposals and approved transactions contain financial data
and are handled by the user's AtomicServer; they are not sent to an LLM.

Amounts are exact signed decimal **strings**, not floating point numbers.
Opening/closing balances are reconciled with integer arithmetic (up to five
fractional digits). Dates have no inferred time zone. Original :86: descriptions
are retained verbatim, including bank-specific structured codes. Bank account
identifiers are preserved, not assumed to be IBANs. Schema term descriptions
record these meanings; this is not a frozen or ISO 20022-certified schema.

Bank references identify transactions within an account, currency and export
format: importing the same period once as MT940 and once as camt.053 yields two
sets of rows, because the two formats carry different narratives and a shared
identity would surface that as a conflict instead. A changed reference payload
blocks the import. Without references, statement metadata and
line position identify records; content fingerprints block ambiguous overlap
with earlier exports. Identical legitimate rows within a statement are retained.
Import is append-only: local edits are not overwritten. Deleted imports may be
recreated on another import. Native `localId` identities are unique within the destination on one AtomicServer: a
concurrent duplicate create is rejected and must be previewed again. The shared
`importBaseline` records source values and protects local edits. Independent
offline peers still need collision resolution after synchronization.

## Supported scope and gaps

- Up to 500 entries; MT940 up to 512 KB (UTF-8 or Windows-1252 text), camt.053
  up to 1 MB (UTF-8 XML, which is what ISO 20022 mandates).
- MT940: :20:, :21:, :25:, :28:/28C:, :60F:/60M:, :61:, :86:, :62F:/62M:, :64:, :65:.
- camt.053 (.001.02 through .001.08 element names): one or more `Stmt` per
  `BkToCstmrStmt`; `Acct/Id` IBAN or `Othr/Id`; `OPBD` (or `PRCD`) and `CLBD`
  balances, reconciled against the booked `Ntry` amounts; `BookgDt`/`ValDt` as
  `Dt` or `DtTm`; `BkTxCd` domain/family/sub-family or proprietary code;
  `AcctSvcrRef` as bank reference, `EndToEndId` (when provided) or `NtryRef` as
  reference; counterparty name and account, `RmtInf` lines, `AddtlTxInf` and
  `AddtlNtryInf` as the narrative. Entries with a status other than `BOOK` are
  left out, since only booked entries move the booked balances. A batch entry
  with several `TxDtls` stays one row.
- Credit/debit reversals, optional booking dates (value date fallback), multiple
  statements/accounts, multiline transaction narratives.
- Unsupported fields, missing balances and reconciliation failures block import.
- JSON-shaped narratives are rejected because legacy storage reinterprets those
  strings. This needs a general text-preservation fix before enabling them.
- No live bank access, payments, CSV/PDF, counterparty extraction or categorization.
- Amount columns cannot yet use numeric table aggregation; an exact decimal
  datatype/table formatter is a follow-up.
- A supplied real bunq statement with 272 transactions passed preview, apply and
  zero-change reimport locally on 2026-09-11. Private bank data is not committed. Synthetic fixtures
  test format behavior; this does not establish compatibility with every bank's
  dialect.
- The default importer, table and view reuse durable setup identities after lost
  responses. Shared ontology/schema creation still needs resumable installation.
- File importer metadata/UI dispatch is currently MT940-specific; generalize this
  when adding the next file-based plugin. It uses the same proposal runtime.

Reference: https://bankrec.westpac.com.au/docs/statements/mt940/

Tests: `./browser/node_modules/.bin/vitest run --config integrations/mt940/vitest.config.ts`
(`parser.test.ts` for MT940, `camt053.test.ts` for camt.053 and format detection).
Bundle: `./browser/node_modules/.bin/esbuild integrations/mt940/plugin.ts --preserve-symlinks --bundle --format=esm --platform=neutral --target=es2022 > integrations/mt940/plugin.js`
Browser: `browser/e2e/tests/mt940.spec.ts` (synthetic MT940 and camt.053 files, real runtime/persistence).
