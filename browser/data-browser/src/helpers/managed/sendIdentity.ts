import { managedFetch } from './api';
import type { RecoverySecret } from './recovery';
import {
  isValidAppKey,
  sealIdentity,
  type SealedIdentity,
} from './identityHandback';

/**
 * Handing the identity to an app that started a device link with an `app_key`
 * (planning/flutter-secret-handback.md). The page is `/app/send-identity`.
 */

export type LinkDescription = {
  deviceName: string;
  alreadyApproved: boolean;
  /** Null for a link that did not ask for the identity. */
  appKey: string | null;
};

export class NoLinkError extends Error {}

/** What the provider says about a code. Needs the account's cookie session. */
export async function describeLink(code: string): Promise<LinkDescription> {
  const response = await managedFetch(
    `/device-link/code/${encodeURIComponent(code)}`,
  );

  if (response.status === 404) {
    throw new NoLinkError(
      'That code is not valid any more. Ask the device for a new one.',
    );
  }

  if (!response.ok) throw new Error('Could not look up that code.');

  const body = (await response.json()) as {
    device_name?: string;
    already_approved?: boolean;
    app_key?: string | null;
  };

  return {
    deviceName: body.device_name?.trim() || 'a device',
    alreadyApproved: !!body.already_approved,
    appKey: isValidAppKey(body.app_key) ? body.app_key : null,
  };
}

/** Store the sealed identity with the link. The provider approves it too. */
export async function depositSealedIdentity(
  code: string,
  sealed: SealedIdentity,
): Promise<void> {
  const response = await managedFetch(
    `/device-link/code/${encodeURIComponent(code)}/identity`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sealed),
    },
  );

  if (response.status === 409) {
    throw new Error(
      'This code was already used. Ask the device for a new one.',
    );
  }

  if (!response.ok) throw new Error('Could not send your identity.');
}

/** Seal the unlocked secret to the app's key and deposit. */
export async function sendIdentity(
  code: string,
  link: LinkDescription,
  recovery: RecoverySecret,
  secret: string,
): Promise<void> {
  if (!link.appKey)
    throw new Error('This device did not ask for your identity.');

  const sealed = await sealIdentity(link.appKey, {
    secret,
    subject: recovery.agent_subject,
    drive: recovery.drive_subject ?? null,
  });

  await depositSealedIdentity(code, sealed);
}
