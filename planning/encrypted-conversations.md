# Encrypted conversations

Direct messages and group chats between agents, end-to-end encrypted
whoever hosts them. The host stores ciphertext, and still authorizes every
write, because everything authorization needs stays readable.

## What exists (first version)

- [x] `atomic_lib::conversation`: agent encryption keys, the keyring, sealing
      and opening messages, report-by-reveal of one message key.
- [x] WASM exports `conversationEncryptionKey`, `conversationAddEpoch`,
      `conversationSeal`, `conversationOpen`, `conversationSealFile`,
      `conversationOpenFile`.
- [x] Ontology `conversations` (`lib/defaults/conversations.json`):
      `Conversation`, `SealedMessage`, `encryptionKey`, `conversationKeys`,
      `sealed`, `conversations`.
- [x] `GET /conversations`: the conversations on this server the requester is
      in, found through the reference index on `read`.
- [x] App: Messages panel in the sidebar, "Message" on every avatar menu, a
      New message dialog that takes an agent DID, the conversation page.
- [x] The app publishes the signed-in agent's `encryptionKey` at start.
- [x] Encrypted attachments (see Attachments).

## Model

- A **Conversation** is a drive of its own (`isA` `[Conversation, Drive]`),
  never inside someone's private drive or a team drive. Members get `read`
  and `append`, and nobody has `write`: a `write` on the drive would reach
  every message in it. The server grants a DID resource's creator `write` at
  genesis, so the creator removes it in a second commit. Each message sets
  `write` to its author only, so nobody can edit or replace someone else's
  ciphertext. The price: the keyring and members can't change yet, which
  epoch rotation will need (see Next).
- It is listed in the creator's private drive under `conversations`, not
  `drives`, so it never shows up as a workspace. The other members find it
  through `/conversations`; it joins their own list when they open it from an
  avatar menu or the New message dialog.
- Live updates: the conversation is a drive, so a `SUB` on it gets drive
  fan-out. The app holds one with `Store.subscribeLive` while the page is open
  (the same method as PR 1949, copied verbatim so the two merge cleanly).

## Keys

- **Agent key**: X25519, `blake3::derive_key("atomic 2026 agent conversation
  encryption key", vault_proof)`, where the vault proof is the agent's Ed25519
  signature over the fixed vault message (`helpers/managed/vault.ts`). Every
  device of the agent derives the same key, so a restored identity reads every
  past conversation. The public half is `encryptionKey` on the Agent.
- **Keyring** (`conversationKeys`, JSON): one random 32-byte key per epoch,
  wrapped to each member with an ephemeral X25519 exchange, BLAKE3 KDF and
  XChaCha20-Poly1305. The wrap is bound to the member and the epoch.
- **Sealed message** = base64url(version | epoch (4 BE) | message id (16) |
  nonce (24) | ciphertext). The per-message key is derived from the epoch key
  and the random message id (the DID subject is unknown before signing). The
  associated data is the header plus the conversation subject, so a message
  can't be replayed into another conversation.
- The payload is JSON `{text, replyTo?, attachments?}`: what a `Message`
  carries in the clear, plus the files. A payload without `attachments` is the
  old shape and reads as before.

## Attachments

- A file is encrypted on the sender's device by `seal_file` (XChaCha20-Poly1305,
  a random 32-byte key and 24-byte nonce per file, layout `version(1) | nonce(24)
  | ciphertext+tag`, associated data `"atomic 2026 conversation file"` plus the
  conversation subject). The file key is not derived from the epoch key: it
  lives only in the sealed payload, so a later epoch rotation changes nothing.
- The payload lists `{blob, key, name, type, size, width?, height?}` per file;
  `blob` is `atomic:blob:<blake3 of the ciphertext>`. Name, real type and
  dimensions exist only inside the ciphertext.
- The ciphertext is uploaded through `Store.uploadFiles` (the local blob store,
  then `PUT /blob/<hash>` from the outbox), as a `File` whose `parent` is the
  author's own SealedMessage, `filename` `attachment` and `mimetype`
  `application/octet-stream`. A member has only `append` on the conversation, so
  the multipart `/upload` path (which needs `write`) is not used. The File goes
  out after the message; the host learns a size and nothing else.
- Readers fetch the ciphertext from their blob store or from
  `/download/files/<hash>` (unauthenticated: the hash is the capability and the
  bytes are ciphertext), decrypt in memory and never store the plaintext. Only
  png, jpeg, gif and webp are previewed inline; everything else is a download
  typed `application/octet-stream`, so a sender-chosen `text/html` or SVG type
  can never become an object URL on the app origin.
- Limits: 25 MiB per file and 10 files per message, checked before anything is
  encrypted (the wasm module holds plaintext, ciphertext and key material at
  once; the server body cap is 47.9 MiB). Larger files need chunked encryption.
- Blobs are not garbage collected: destroying a File stops it counting towards
  the drive's usage but leaves the bytes in the blob backend
  (`planning/s3-blob-storage.md`, "Blob garbage collection").
- Not done: a Playwright case (attach a small PNG, the other context sees it),
  and quota for attachments on a hosted conversation.

## What the host sees

Members, who posts and when, message counts and sizes, key epochs. Not the
text. Server search, AI and previews don't work on conversations; that is the
price.

## Why not MLS

MLS needs one total order for group changes, per-device keys, and state that
can't be lost. Atomic is offline-first with one key per agent across devices.
If it is ever needed, MLS's exporter secret becomes the epoch key and
`SealedMessage` stays as it is.

## Next

- [ ] Epoch rotation when members change (`Keyring::add_epoch` exists; no
      UI). Needs a way to change the keyring and ACL without a drive-wide
      `write`, such as a server rule that `write` on a Conversation does not
      reach its SealedMessages.
- [ ] Group conversations from the UI (the model already supports them).
- [ ] Notifications for new messages (needs the notifier, see
      `planning/notifications.md`).
- [ ] Conversations hosted on another server than the reader's.
- [ ] Report-by-reveal on the host.
- [ ] Local search over decrypted messages.
- [ ] Flutter client.
