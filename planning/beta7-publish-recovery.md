# Beta 7 crate publishing recovery

- [x] Identify failure: katyo/publish-crates@v1 runs cargo update between packages, upgrading precis-profiles to an incompatible release after atomic_lib published.
- [x] Replace action with locked cargo publishing and exact-version registry checks for safe partial retries.
- [x] Add manual crates-only recovery from the existing immutable tag.
- [ ] Validate locked server package verification against the tag.
- [ ] Merge workflow fix and dispatch recovery for v0.41.0-beta.7.
- [ ] Verify server crate and remaining release artifacts; remove completed release plans.

atomic_lib and atomic-cli beta7 already published. Never move the tag or republish those versions. macOS and GNU Linux server assets are available; musl and Tauri jobs were still running at the last check.

Recovery run 34714749065 resolved the validated dependencies successfully, then failed because the tagged package allowlist omits server/build_assets.rs. Add the existing module to the allowlist and apply this metadata-only correction when recovering beta.7, without moving the tag or changing Rust source.
