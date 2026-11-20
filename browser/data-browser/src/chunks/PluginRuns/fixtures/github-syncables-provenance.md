# GitHub collection-navigation fixture

Generated with `compose("github", cache, catalog)` from
`overlays/tests/generate_identity_catalog_fixtures.py` in paired
`ontola/atomic-plugins` PR #755, commit
`79f085e1cdae4f05105c4ecbb68cc3e1a03a3f5a`. The versioned input is
`overlays/catalog/2026-11-20-reference-links.json`. The selection fixture is the
GitHub platform's `selection` object; the second return value of `compose` is
source provenance and is not a consumer selection. Composition uses the
pinned OpenAPI document and immutable overlays, including CRUD references,
Authenticated Principal metadata and standard OpenAPI response Links. No
account credentials or live user data are included.

Checked-in output SHA-256 (JSON formatted with the server formatter):

- `github-syncables-catalog.json`: `c0683d416cd899998f125575e8977589d36611aaa1bc78f4fa04a4a90234a73d`
- `github-syncables-selection.json`: `757618f3abe32fb8319b6923b27bd612f062fc2aeb52d889e4016228f7a7b573`

The collection is labelled Issues and pull requests because GitHub's Issues
endpoint includes both. Fixture records in unit/browser tests are invented.
