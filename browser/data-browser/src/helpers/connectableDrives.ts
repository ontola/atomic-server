import { isNotEnrolledMessage, type Store } from '@tomic/react';
import type { ManagedEnrollmentSummary } from './managed/enrollmentApi';

type DriveStore = Pick<Store, 'isLocalOnlyDrive' | 'normalizeSubject'>;

/**
 * The drives among `subjects` that a hosted app cannot reach, because the node
 * does not hold them: browser-only drives always, and, when the account's
 * enrollments are known, a drive no enrollment hosts on `nodeOrigin` (a
 * `Disabled` one does not, nor one on another node). An enrollment without an
 * `http_origin` counts for any node.
 *
 * `enrollments` is `undefined` when they could not be fetched (no session, an
 * unreachable control plane, a node that is not managed). That is "could not
 * find out", never "not hosted": such a drive stays available, and a save the
 * node refuses is reported when the person presses Allow.
 */
export function unreachableDrives(
  store: DriveStore,
  subjects: string[],
  enrollments:
    | Pick<
        ManagedEnrollmentSummary,
        'drive_subject' | 'status' | 'http_origin'
      >[]
    | undefined,
  nodeOrigin?: string,
): string[] {
  const origin = (url: string) => {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  };

  const onThisNode = (url: string | null | undefined) =>
    !url || !nodeOrigin || origin(url) === origin(nodeOrigin);
  const hosted = new Set(
    (enrollments ?? [])
      .filter(
        enrollment =>
          enrollment.status !== 'Disabled' &&
          onThisNode(enrollment.http_origin),
      )
      .map(enrollment => store.normalizeSubject(enrollment.drive_subject)),
  );

  return subjects.filter(
    subject =>
      store.isLocalOnlyDrive(subject) ||
      (enrollments !== undefined &&
        !hosted.has(store.normalizeSubject(subject))),
  );
}

/**
 * A sentence for the person when saving a grant failed on some drives. Names
 * drives by title, never by subject. `titleOf` gives the title of a drive.
 */
export function grantFailureMessage(
  failed: { subject: string; error: unknown }[],
  titleOf: (subject: string) => string,
  app: string,
  node: string,
): string {
  const text = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  const notEnrolled = failed.filter(f => isNotEnrolledMessage(text(f.error)));
  const other = failed.filter(f => !isNotEnrolledMessage(text(f.error)));
  const parts: string[] = [];

  if (notEnrolled.length > 0) {
    const titles = notEnrolled.map(f => titleOf(f.subject)).join(', ');
    parts.push(
      `${titles} only lives on your devices, so ${app} cannot reach it through ${node}. Deselect it, or turn on Cloud Server for that drive.`,
    );
  }

  if (other.length > 0) {
    const titles = other.map(f => titleOf(f.subject)).join(', ');
    parts.push(
      `Could not give ${app} access to ${titles}: ${text(other[0].error)}`,
    );
  }

  return parts.join(' ');
}
