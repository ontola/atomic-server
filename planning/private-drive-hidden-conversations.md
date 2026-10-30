# Follow-up: sync hidden conversations through the private drive

Drive-list management stores `server.properties.hiddenDrives` on the private
drive. Conversations currently use a separate device-local list in
`browser/data-browser/src/helpers/conversations/hiddenConversations.ts`
(`atomic.hidden-conversations`). Both suppress resources that discovery keeps
listing and allow them to be restored. Align these persistence models in a
follow-up, rather than generalizing the drive helper before the conversation
migration has a consumer.

- [ ] Add a dedicated private-drive ResourceArray property for hidden
  conversations. Do not reuse `hiddenDrives` for a different resource type.
- [ ] Migrate the existing device-local entries into the signed-in user's
  private drive, with explicit account attribution; retain the local source
  until the save succeeds. Do not silently assign another account's entries.
- [ ] Make hide, restore, discovery filtering and conversation-twin handling use
  the private-drive preference. Canonicalize subject aliases consistently.
- [ ] Extract shared list-visibility mutations from `driveListManagement.ts`
  when both consumers use them, accepting the list and hidden properties.
- [ ] Verify reload, offline edits, account switching, existing local-list
  migration and cross-device delivery; hiding must not delete content or leave
  the conversation on the server.
