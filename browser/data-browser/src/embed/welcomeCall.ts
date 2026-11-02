// @wc-ignore-file
/**
 * The app's first run builds the "Welcome to Atomic" drive with the web's own
 * `startWelcomeDrive`, so the template stays the one source of truth. The app
 * loads this page without a screen (`?welcome=1`), calls
 * `atomicEmbed.startWelcome(id, personalDrive)` and hears the answer on its
 * channel, as `runJavaScript` does not wait for a promise:
 * `{method:'welcomeResult', callId, ok, payload}` where `payload` is the JSON
 * `{drive, landing}` on success, or the error text.
 *
 * Everything is written through this page's store to the app's Rust store, so
 * the new drive is a drive of the identity the app made a moment before.
 */
import type { Store } from '@tomic/react';
import { startWelcomeDrive } from '../helpers/startWelcomeDrive';
import { adoptDriveOf } from './embedStore';

export interface WelcomeDeps {
  store: Pick<Store, 'getResource'> &
    Parameters<typeof startWelcomeDrive>[0] &
    Parameters<typeof adoptDriveOf>[0];
  /** Hands every pending edit to the host. */
  flush: () => Promise<void>;
  post: (message: string) => void;
  build?: typeof startWelcomeDrive;
}

export async function welcomeCall(
  { store, flush, post, build = startWelcomeDrive }: WelcomeDeps,
  callId: number,
  personalDrive: string,
): Promise<void> {
  let ok = true;
  let payload: string;

  try {
    // The personal drive first, as the page does before it shows anything:
    // the new drive is listed on it, and lists are asked of the current drive.
    await store.getResource(personalDrive);
    await adoptDriveOf(store, personalDrive);

    const result = await build(store, personalDrive);

    await flush();
    payload = JSON.stringify(result);
  } catch (e) {
    ok = false;
    payload = e instanceof Error ? e.message : String(e);
  }

  post(JSON.stringify({ method: 'welcomeResult', callId, ok, payload }));
}
