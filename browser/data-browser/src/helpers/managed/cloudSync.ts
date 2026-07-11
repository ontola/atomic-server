// Turning on hosted sync for a drive the user already has locally — the
// "Back up to Cloud Sync" action on the /sync page. This is the bridge between
// the open-core connection layer (connect a server, promote a local drive) and
// the SaaS control plane (account + per-drive enrollment that assigns a node).
//
// The steps, in order, because they depend on each other:
//   1. There must be a managed account/session — without one there's nothing to
//      enroll against, so we bail out asking the caller to send the user to the
//      portal to sign up.
//   2. Create the enrollment. The control plane picks an available node and
//      returns its `http_origin`; only after the enrollment exists will that
//      node ACCEPT the drive's pushed commits (open nodes admit anything; a
//      managed node checks the enrollment first).
//   3. Point the app at that node and, if the drive was local-only, promote it
//      so the sync engine actually pushes it up.

import { getManagedAccount } from './session';
import { createManagedSyncEnrollment } from './enrollment';
import { getManagedEnrollments } from './enrollmentApi';
import type { ManagedInfo } from '../managedServer';
import { type Store, StoreEvents } from '@tomic/react';

/**
 * Where to send a user to create a Cloud Sync account, or null when no portal
 * is known (a plain self-hosted / FOSS node has none, so the CTA stays hidden).
 * Priority: build-time override → the connected managed node's advertised
 * portal → the local dev portal.
 */
export function getManagedPortalUrl(info?: ManagedInfo | null): string | null {
  const fromEnv =
    typeof import.meta !== 'undefined'
      ? (import.meta.env?.VITE_MANAGED_PORTAL_URL as string | undefined)
      : undefined;

  if (fromEnv) return fromEnv.replace(/\/+$/, '');

  if (info?.portalUrl) return info.portalUrl;

  if (typeof window !== 'undefined') {
    const { hostname } = window.location;

    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return 'http://localhost:49237';
    }
  }

  return null;
}

/**
 * Is a Cloud Sync backup even offered here? True when there's a portal to sign
 * up at (or the app was built pointing at one). Keeps the CTA out of a pure
 * self-hosted node's UI, where there is no control plane to enroll against.
 */
export function isCloudSyncAvailable(info?: ManagedInfo | null): boolean {
  return getManagedPortalUrl(info) !== null;
}

/**
 * Whether `drive` already has a live enrollment on the control plane. Returns
 * false without a session or when the control plane is unreachable (both mean
 * "not backed up yet"), so the CTA shows rather than hides on a transient error.
 */
export async function driveHasCloudEnrollment(drive: string): Promise<boolean> {
  const enrollments = await getManagedEnrollments();

  return enrollments.some(
    e => e.drive_subject === drive && e.status !== 'Disabled',
  );
}

/** Resolve once the store reports a live server connection, or reject on timeout. */
function waitForServerConnected(store: Store, timeoutMs = 20_000): Promise<void> {
  if (store.getSyncStatus().serverConnected) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const finish = (err?: Error) => {
      clearTimeout(timer);
      unsubscribe();

      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    const timer = setTimeout(
      () => finish(new Error('Timed out connecting to the Cloud Sync node.')),
      timeoutMs,
    );

    const unsubscribe = store.on(StoreEvents.ConnectionChanged, () => {
      if (store.getSyncStatus().serverConnected) finish();
    });
  });
}

export type EnableCloudSyncResult =
  | { ok: true; httpOrigin: string | null }
  | { ok: false; reason: 'no-account'; portalUrl: string | null };

/**
 * Enroll `drive` in Cloud Sync and start syncing it to the assigned node. See
 * the file header for the ordering. Returns `{ ok: false, reason:'no-account' }`
 * (never throws) when there's no session, so the caller can route the user to
 * the portal; throws on a real enrollment/connection failure.
 */
export async function enableCloudSyncForDrive(params: {
  store: Store;
  drive: string;
  agentSubject: string;
  setServer: (url: string) => void;
  managedInfo?: ManagedInfo | null;
}): Promise<EnableCloudSyncResult> {
  const { store, drive, agentSubject, setServer, managedInfo } = params;

  const account = await getManagedAccount().catch(() => null);

  if (!account) {
    return {
      ok: false,
      reason: 'no-account',
      portalUrl: getManagedPortalUrl(managedInfo),
    };
  }

  const wasLocalOnly = store.isLocalOnlyDrive(drive);

  const enrollment = await createManagedSyncEnrollment({
    driveSubject: drive,
    agentSubject,
  });

  const httpOrigin = enrollment.http_origin ?? null;

  if (httpOrigin) {
    // Point the app at the assigned node. A local-only drive then needs an
    // explicit promote (it was excluded from sync); a drive already on this
    // node's origin resyncs through the normal reconnect.
    setServer(httpOrigin);

    if (wasLocalOnly) {
      await waitForServerConnected(store);
      await store.promoteLocalDrive(drive);
    }
  } else if (wasLocalOnly && store.getSyncStatus().serverConnected) {
    // No origin came back (older control plane) — best effort against whatever
    // node is currently connected.
    await store.promoteLocalDrive(drive);
  }

  return { ok: true, httpOrigin };
}
