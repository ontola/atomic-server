# Desktop PKARR restore

Status: discovery and explicit fetch shipped in beta.6 (desktop restore
discovers reachable workspace sources and accepts a manual server address).
Trimmed 2026-09-15 from a live-session transcript to the open items only.

- [ ] Resolve private-drive hosting policy: a restored private drive is not
      enrolled for sync on the managed node, so `SYNC_PUSH` is rejected and the
      browser can show "In sync" while its `lastDriveSync` belongs to another
      drive. Decide enrollment for private drives without bypassing managed
      admission, then reconcile browser and staging and verify desktop content
      matches. Product decision pending.
- [ ] Verify a private-workspace fetch after the user signs in on a fresh
      desktop install.
- [ ] Reproduce the beta.5 packaged-build missing recovery-screen text; dev
      rendering alone does not establish the cause.

Do not report restoration success from the drive resource or the PKARR
connection alone; compare actual child resources.
