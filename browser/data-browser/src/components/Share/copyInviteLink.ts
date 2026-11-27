import toast from 'react-hot-toast';
import type { ShareRole } from './RoleSelect';
import type { useCreateInviteLink } from './useCreateInviteLink';

export type CreateInviteLink = ReturnType<typeof useCreateInviteLink>;

/**
 * Creates an invite link and puts it on the clipboard. The record is saved
 * whenever the link was created and shown to the person, also when the
 * clipboard refuses (Safari, embedded browsers): they can copy it by hand.
 */
export async function copyInviteLink(
  createInviteLink: CreateInviteLink,
  role: ShareRole,
  maxUsages?: number,
  onCopied?: (role: ShareRole) => Promise<void>,
): Promise<string> {
  const link = await createInviteLink({ write: role === 'write', maxUsages });

  try {
    await navigator.clipboard.writeText(link);
    toast.success('Invite link copied');
  } catch {
    toast.error('Could not copy the link. Select it and copy it by hand.');
  }

  // Leaves a record, so "someone was invited" can be derived later. Failing
  // to note it must not read as a failed copy.
  await onCopied?.(role).catch(() => undefined);

  return link;
}
