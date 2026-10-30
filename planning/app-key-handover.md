# Recover app key handovers after reconnect

- [x] Trace offline install: local resources survive, one-shot app-agent handover discards the generated secret.
- [ ] Reproduce loss with a focused browser-side test.
- [ ] Retain failed handovers encrypted under the existing per-agent local database key, bound to the owner, node, drive and app.
- [ ] Add an idempotent initialization-only server handshake so retries cannot replace or revive an identity.
- [ ] Retry on startup/reconnect after resource sync, and reload only the affected app frame after success.
- [ ] Cover reload, account/node changes, encryption, retry failures, replacement and revocation.
- [ ] Run targeted checks and package the reviewed change for the host maintainer.

Existing installations whose original secret was already discarded require reinstalling the view. No automatic identity rotation and no secrets in synced resources or logs.
