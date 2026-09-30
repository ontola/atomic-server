import type { Store } from '@tomic/lib';

/** A portal link is a selection request, not proof the node can read a drive.
 * Recovery owns selection until its data is available. Recheck identity and
 * navigation after the read, which may finish after either has changed. */
export async function selectReadableDrive(
  store: Store,
  subject: string,
  select: (subject: string) => void,
  isCurrent: () => boolean,
): Promise<boolean> {
  const agent = store.getAgent();

  try {
    const resource = await store.getResource(subject);

    if (resource.error || !isCurrent() || store.getAgent() !== agent) {
      return false;
    }

    select(subject);

    return true;
  } catch {
    // ResourcePage handles missing resources and authentication.
    return false;
  }
}
