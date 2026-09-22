import type { Store } from '@tomic/react';
import { fetchManagedInfo } from '../../helpers/managedServer';
import { getManagedEnrollments } from '../../helpers/managed/enrollmentApi';
import { prepareDriveSharing } from '../../helpers/managed/prepareDriveSharing';
import { sameOrigin } from '../../helpers/serverUrl';

/** Make the home index writable locally before adding a browser-only drive. */
export async function prepareTemplateDrive(store: Store): Promise<void> {
  const serverUrl = store.getServerUrl();
  const info = await fetchManagedInfo(serverUrl);
  if (!info.managed) return;

  const agent = store.getAgent();
  if (!agent) return; // createDrive reports the missing identity.
  const home = await agent.privateDriveSubject();
  if (store.isLocalOnlyDrive(home)) return;

  const enrollments = await getManagedEnrollments(true);
  const enrolledHereOrUnknown = enrollments.some(
    enrollment =>
      enrollment.drive_subject === home &&
      enrollment.status !== 'Disabled' &&
      (!enrollment.http_origin ||
        sameOrigin(enrollment.http_origin, serverUrl)),
  );
  if (enrolledHereOrUnknown) return;

  const enrolledElsewhere = enrollments.some(
    enrollment =>
      enrollment.drive_subject === home && enrollment.status !== 'Disabled',
  );
  if (enrolledElsewhere)
    throw new Error(
      'This workspace is hosted on another device. Connect to it before creating a drive.',
    );

  await prepareDriveSharing(store, home, enrollments);
}
