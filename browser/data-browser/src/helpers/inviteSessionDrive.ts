/** Drives persistAgentAfterInvite hands to activateDrive. */
export type InviteSessionDrives = {
  privateDrive?: string;
  hostDrive?: string;
  destinationIsDrive?: boolean;
};

/**
 * Session drive after accepting an invite.
 *
 * Drive-level invites land on the granted host. Child invites (chatroom,
 * document) grant the destination, not the parent — stay on the invitee's
 * private drive rather than an unreadable host (`Unauthorized` / truncated
 * DID in the sidebar).
 */
export function inviteSessionDrive(
  drives: InviteSessionDrives,
): string | undefined {
  return drives.destinationIsDrive
    ? (drives.hostDrive ?? drives.privateDrive)
    : drives.privateDrive;
}
