import type { OutboxEntry, StoreSyncStatus } from '@tomic/react';

/** What the person can do about a sync problem, from the banner. */
export type SyncProblemAction =
  | 'try-again'
  | 'connect-device'
  | 'review-sync'
  | 'storage';

/**
 * Something that stops this workspace from syncing, in words for the person.
 *
 * `cause` decides the voice. `ours` is a failure nothing the person did can
 * explain, so it says we have been told and offers Try again. `you` is
 * something only they can change (a workspace the server does not hold, no
 * write access, a full plan), so it names the remedy instead.
 */
export type SyncProblem = {
  /** Stable for the same problem, so it is reported once. */
  key: string;
  cause: 'ours' | 'you' | 'offline';
  title: string;
  body: string;
  actions: SyncProblemAction[];
  /** The raw message, for a person who wants to quote it. */
  detail?: string;
  /**
   * Sentry already has this one: the outbox reports a commit that keeps
   * failing by itself, so reporting it again would count it twice.
   */
  reported: boolean;
};

export type SyncProblemInput = {
  status: StoreSyncStatus;
  /** `store.isDriveRefusedByServer(drive)`. */
  refusedByServer: boolean;
  /** `store.outbox.pending()`. */
  entries: readonly Pick<
    OutboxEntry,
    'subject' | 'blocked' | 'failures' | 'lastAttemptError'
  >[];
  /** The server in use, as a person reads it: `atomicserver.eu`. */
  serverName: string;
};

/** The outbox reports a commit to Sentry after this many failed drains. */
const REPORTED_AFTER_FAILURES = 4;

const QUOTA = /storage quota|quota exceeded|over (its|your) quota/i;
const NO_ACCESS =
  /unauthori[sz]ed|forbidden|no write|write right|not allowed|permission|\b40[13]\b/i;
const MISSING_PARENT = /Parent of .+ not found/;
const NOT_ENROLLED = /is not enrolled for sync on this node/;

function firstError(
  entries: SyncProblemInput['entries'],
  keep: (entry: SyncProblemInput['entries'][number]) => boolean,
): string | undefined {
  return entries.find(e => keep(e) && e.lastAttemptError)?.lastAttemptError;
}

/** Name the remedy for an error message that retrying cannot fix, or null. */
function fromMessage(
  message: string,
  serverName: string,
  reported: boolean,
): SyncProblem | null {
  if (NOT_ENROLLED.test(message) || MISSING_PARENT.test(message)) {
    return {
      key: 'not-hosted',
      cause: 'you',
      title: 'This server does not have this workspace',
      body: `${serverName} refuses changes to it, so they stay on this device for now. Connect a device that has this workspace, or turn off server sync for it to keep working here.`,
      actions: ['connect-device', 'review-sync'],
      detail: message,
      reported,
    };
  }

  if (QUOTA.test(message)) {
    return {
      key: 'quota',
      cause: 'you',
      title: 'Your storage is full',
      body: 'New changes stay on this device until there is room. Free up space or move to a bigger plan, and they will sync.',
      actions: ['storage'],
      detail: message,
      reported,
    };
  }

  if (NO_ACCESS.test(message)) {
    return {
      key: 'no-access',
      cause: 'you',
      title: 'You can’t change this workspace on the server',
      body: 'Your account has no write access there. Your changes stay on this device. Ask the owner to give you access.',
      actions: [],
      detail: message,
      reported,
    };
  }

  return null;
}

function ours(
  key: string,
  title: string,
  detail: string | undefined,
  reported: boolean,
): SyncProblem {
  return {
    key,
    cause: 'ours',
    title,
    body: 'This is a problem on our side, not something you did. Your changes are safe on this device and will sync once it is fixed.',
    actions: ['try-again'],
    detail,
    reported,
  };
}

/**
 * The one thing most worth telling the person about why this workspace is not
 * syncing, or null when nothing is wrong.
 *
 * Reads the same facts as the sidebar's warning icon (parked changes, changes
 * that keep failing) and adds the ones the icon cannot show: a server that
 * refuses the workspace, a refused sync and a lost connection. Most urgent
 * first.
 */
export function describeSyncProblem(
  input: SyncProblemInput,
): SyncProblem | null {
  const { status, refusedByServer, entries, serverName } = input;

  if (refusedByServer) {
    const refused = fromMessage(
      'is not enrolled for sync on this node',
      serverName,
      true,
    );

    // The message above only picks the wording; it is not the server's.
    return refused && { ...refused, detail: undefined };
  }

  if (!status.serverConnected && status.serverConnectionError) {
    return {
      key: 'offline',
      cause: 'offline',
      title: `Can’t reach ${serverName}`,
      body: 'Your changes are kept on this device and sync when the connection is back.',
      actions: ['try-again'],
      detail: status.serverConnectionError,
      reported: true,
    };
  }

  const driveError =
    status.lastDriveSyncError &&
    status.lastDriveSyncError.drive === status.drive
      ? status.lastDriveSyncError.message
      : undefined;

  if (driveError) {
    return (
      fromMessage(driveError, serverName, false) ??
      ours('drive-sync', 'This workspace could not sync', driveError, false)
    );
  }

  const blocked = entries.filter(e => e.blocked);

  if (status.blockedCount > 0 || blocked.length > 0) {
    const message = firstError(entries, e => !!e.blocked);
    // Parked after the outbox reported them, so Sentry has these already.
    const known = message ? fromMessage(message, serverName, true) : null;

    return (
      known ?? ours('blocked', 'Some changes could not sync', message, true)
    );
  }

  const failing = entries.filter(
    e => (e.failures ?? 0) >= REPORTED_AFTER_FAILURES,
  );

  if (failing.length > 0 && status.serverConnected) {
    const message = firstError(entries, e => failing.includes(e));

    return (
      (message ? fromMessage(message, serverName, true) : null) ??
      ours('failing', 'Some changes keep failing to sync', message, true)
    );
  }

  return null;
}
