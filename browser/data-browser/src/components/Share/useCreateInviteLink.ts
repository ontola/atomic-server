import { useStore, useCurrentAgent, server, type Resource } from '@tomic/react';
import { generateInviteToken } from '@tomic/lib';
import { prepareDriveSharing } from '../../helpers/managed/prepareDriveSharing';
import { managedFetch } from '../../helpers/managed/api';
import {
  automaticPeerRoom,
  defaultPeerSignalingUrl,
  savePeerLink,
  resumePeerLinks,
} from '../../helpers/browserPeerSync';
import { getManagedPortalUrl } from '../../helpers/managed/cloudSync';
import { isDev } from '../../config';

export interface InviteLinkOptions {
  write: boolean;
  /** Unix ms timestamp after which the invite no longer works */
  expiresAt?: number;
}

/**
 * Returns a function that signs an invite token for `target` and builds the
 * `/app/invite` URL for it. Shared by the Share dialog (link and email
 * invites) and the Permissions & Invites page.
 */
export function useCreateInviteLink(
  target: Resource,
): (options: InviteLinkOptions) => Promise<string> {
  const store = useStore();
  const [agent] = useCurrentAgent();
  const isSaas = !!getManagedPortalUrl();

  return async ({ write, expiresAt }) => {
    if (!agent) {
      throw new Error('No agent found');
    }

    const isDrive = target.hasClasses(server.classes.drive);
    let browserPeer = isDrive && store.isLocalOnlyDrive(target.subject);

    if (isDrive && isSaas && !browserPeer) {
      const response = await managedFetch('/sync-enrollments', {});

      if (!response.ok || response.status === 204)
        throw new Error(
          'Sign in to your portal account to check this drive before sharing.',
        );
      const body = await response.json();
      const enrollments = Array.isArray(body) ? body : body.enrollments;

      if (!Array.isArray(enrollments))
        throw new Error('Could not check Cloud Server status. Try again.');
      browserPeer = await prepareDriveSharing(
        store,
        target.subject,
        enrollments,
      );
    }

    if (
      browserPeer &&
      !(await store.getClientDb()?.getResourceWithSnapshot(target.subject))
        ?.snapshot
    )
      throw new Error(
        'Wait for this drive to be saved on this device before sharing.',
      );
    const tokenBase64 = await generateInviteToken(
      target.subject,
      agent,
      write,
      expiresAt,
      undefined,
      browserPeer,
    );

    if (browserPeer) {
      savePeerLink(store, {
        drive: target.subject,
        room: await automaticPeerRoom(target.subject),
        signalingUrl: defaultPeerSignalingUrl(),
      });
      resumePeerLinks(store);
    }

    const token = encodeURIComponent(tokenBase64);

    if (browserPeer) {
      return `${window.location.origin}/app/invite?token=${token}`;
    }

    const serverUrl = store.getServerUrl();

    return `${inviteLinkPrefix(serverUrl)}${token}${inviteServerParam(serverUrl)}`;
  };
}

/**
 * The app that opens an invite. The server serves one, except in development,
 * where the app comes from Vite and a server built without its frontend
 * answers every asset with index.html.
 */
function inviteAppOrigin(serverUrl: string): string {
  return isDev() ? window.location.origin : serverUrl.replace(/\/$/, '');
}

/** Names the invite's server when the app that opens it isn't that server. */
function inviteServerParam(serverUrl: string): string {
  const serverOrigin = serverUrl.replace(/\/$/, '');

  return inviteAppOrigin(serverUrl) === serverOrigin
    ? ''
    : `&server=${encodeURIComponent(serverOrigin)}`;
}

/** Where invite links for this store point, before one has been made. */
export function inviteLinkPrefix(serverUrl: string): string {
  return `${inviteAppOrigin(serverUrl)}/app/invite?token=`;
}
