import { describe, expect, it, vi } from 'vitest';
import { core } from './ontologies/core.js';
import { server } from './ontologies/server.js';
import { testStore } from './test-store.js';

/**
 * What happens to a drive that cannot be recorded.
 *
 * `Agent.personalDriveSubject` refuses to derive a personal drive from a
 * signature that is not reproducible — rightly, because signing anyway once
 * minted 411 "My drive"s in a single session. The refusal even names the one
 * action that fixes it.
 *
 * That refusal used to be caught and sent to `console.warn`. The drive was
 * created and then belonged to no list, which from the outside is
 * indistinguishable from the drive having failed to exist.
 */
describe('recording a new drive on the personal drive', () => {
  it('lists the drive when the personal drive is available', async () => {
    const { store } = await testStore();

    const drive = await store.createDrive('Work', { personal: false });
    const personal = await store.ensurePersonalDrive();

    expect(personal.getSubjects(server.properties.drives)).toContain(
      drive.subject,
    );
  });

  it('tells the user when it could not, instead of only the console', async () => {
    const { store } = await testStore();

    vi.spyOn(store, 'ensurePersonalDrive').mockRejectedValue(
      new Error('Sign in with the secret again to recompute it.'),
    );
    const notify = vi.spyOn(store, 'notifyError').mockImplementation(() => {
      // Swallowed here so the test asserts on the call, not on a thrown error.
    });

    const drive = await store.createDrive('Work', { personal: false });

    // The drive is still made: failing to list it is not a reason to lose the
    // user's work as well.
    expect(drive.subject).toBeTruthy();
    expect(drive.get(core.properties.name)).toBe('Work');

    expect(notify).toHaveBeenCalledTimes(1);

    const reported = notify.mock.calls[0][0] as Error;

    // Names the drive, says what did not happen, and carries the remedy the
    // refusal came with — a message that stops at "something went wrong"
    // leaves the user with no way forward.
    expect(reported.message).toContain('Work');
    expect(reported.message).toContain('list of drives');
    expect(reported.message).toContain('Sign in with the secret again');
  });
});
