import { managedFetch } from './api';

export interface ShareInviteRequest {
  emails: string[];
  /** The signed `/app/invite?token=…` link the recipients open */
  link: string;
  /** Title of the shared resource, for the subject line */
  title: string;
  write: boolean;
  /** Name the sender goes by in the app */
  inviterName?: string;
  message?: string;
}

/**
 * Asks the control plane to email an invite link. The link itself grants the
 * access; the email only delivers it, so this never changes any rights.
 */
export async function sendShareInvites(
  request: ShareInviteRequest,
): Promise<void> {
  const response = await managedFetch('/share/invitations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      emails: request.emails,
      link: request.link,
      title: request.title,
      write: request.write,
      inviter_name: request.inviterName,
      message: request.message || undefined,
    }),
  });

  if (response.ok) return;

  if (response.status === 401) {
    throw new Error('Sign in to your account to send invites by email.');
  }

  if (response.status === 429) {
    throw new Error(
      'You have sent a lot of invites recently. Try again later, or copy the invite link instead.',
    );
  }

  let detail: string | undefined;

  try {
    const body = await response.json();
    detail = body?.error ?? body?.message;
  } catch {
    /* Not JSON: fall through to the generic message. */
  }

  throw new Error(detail ?? 'Could not send the invites. Try again.');
}
