import { test, expect, type Page } from '@playwright/test';
import { generateKeyPair } from '@tomic/lib';
import { FRONTEND_URL } from './test-utils';

/**
 * Signing in with a secret whose workspace this device has never held.
 *
 * A secret restores who you are, not what you have — so this is a normal
 * state, and it keeps producing the same complaint: "I made an account on my
 * phone, signed in on my desktop, and my drive wasn't there." The workspace
 * genuinely isn't there. What was wrong is the app carrying on as if it were.
 *
 * The failure has a shape. Nothing sets the active drive when the account's
 * own cannot be found, so it keeps whatever it had — and its default is the
 * server's own root. That is somebody else's workspace, on screen, under your
 * name, immediately after signing in.
 *
 * Deliberately no `before`: that signs in as the dev agent and opens the dev
 * drive, which is the exact state this test must not start from.
 */
test.describe('signing in on a device that holds none of the account’s data', () => {
  /**
   * A real, well-formed secret for an account this server has never seen.
   * Minted with the library's own keygen — hand-rolling one would test my
   * crypto rather than the flow.
   */
  async function strangerSecret(): Promise<string> {
    const { privateKey, publicKey } = await generateKeyPair();

    return btoa(
      JSON.stringify({
        privateKey,
        subject: `did:ad:agent:${publicKey}`,
      }),
    );
  }

  async function signInAsAStranger(page: Page) {
    await page.goto(FRONTEND_URL);

    await page
      .getByRole('button', { name: 'Sign in', exact: true })
      .click({ timeout: 20_000 });
    // No confirm button: the flow signs in as soon as the secret parses.
    const field = page.getByLabel('Agent secret');
    await field.fill(await strangerSecret());
    await field.blur();
  }

  test('stops, and says so, instead of opening a workspace', async ({
    page,
  }) => {
    await signInAsAStranger(page);

    await expect(page.getByText('Your data is on another device')).toBeVisible({
      timeout: 20_000,
    });

    // And offers the way across, rather than only naming the problem.
    await expect(
      page.getByText(/Scan this from that device|Connect a device/),
    ).toBeVisible();
  });

  test('leaves no other workspace active', async ({ page }) => {
    await signInAsAStranger(page);

    await expect(page.getByText('Your data is on another device')).toBeVisible({
      timeout: 20_000,
    });

    const drive = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('drive') ?? '""'),
    );

    // The default is the server's origin. Anything of the server's own is not
    // this account's, and must not be sitting there waiting to be opened.
    expect(drive, 'signing in without data must not leave a drive active').toBe(
      '',
    );
  });
});
