/**
 * Notifications for new chat messages while the app is open: a toast when
 * the person is looking at the app but not at the chat, and an OS
 * notification when the app isn't focused.
 *
 * The OS side is observed through a stub `window.Notification`: the real one
 * needs a permission prompt, and the app itself only ever talks to that API
 * (in Tauri too, where the notification plugin provides it).
 */
import { test, expect, type Page } from './fixtures';
import {
  before,
  editableTitle,
  getCurrentSubject,
  newResource,
  spaUrl,
  timestamp,
  waitForSynced,
  acceptInvite,
  topBarShareButton,
  FRONTEND_URL,
} from './test-utils';

declare global {
  interface Window {
    __osNotifications?: { title: string; body?: string }[];
    __blurred?: boolean;
  }
}

const chatInput = (page: Page) => page.getByLabel('Chat input');

async function send(page: Page, text: string) {
  await chatInput(page).fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText(text)).toBeVisible({ timeout: 15_000 });
}

test.describe('notifications', () => {
  test.beforeEach(before);

  test('a new chat message notifies the other person', async ({
    page,
    browser,
    context,
  }) => {
    test.slow();

    // Stub the OS side and let the test decide when the window has focus.
    await page.addInitScript(() => {
      window.__osNotifications = [];
      class FakeNotification {
        static permission = 'granted';
        static requestPermission = async () => 'granted';
        onclick: (() => void) | null = null;
        constructor(title: string, options?: { body?: string }) {
          window.__osNotifications!.push({ title, body: options?.body });
        }
        close() {}
      }
      // @ts-expect-error: test stand-in for the browser API
      window.Notification = FakeNotification;
      document.hasFocus = () => !window.__blurred;
    });
    await page.reload();

    await newResource('chatroom', page);
    await editableTitle(page).click();
    await page.keyboard.press(
      process.platform === 'darwin' ? 'Meta+a' : 'Control+a',
    );
    await page.keyboard.type('Notify Chat');
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', { name: 'Notify Chat' }),
    ).toBeVisible();
    const hello = `Hello from the owner ${timestamp()}`;
    await send(page, hello);
    const chatSubject = await getCurrentSubject(page);

    // Invite a second person to the chat.
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: new URL(FRONTEND_URL).origin,
    });
    await topBarShareButton(page).click();
    await page.getByLabel('Full name', { exact: true }).fill('Chat Owner');
    await page
      .getByRole('button', { name: 'Save and continue', exact: true })
      .click();
    await page
      .getByLabel('Role for people who join with the link')
      .selectOption('write');
    await page.getByRole('button', { name: 'Copy invite link' }).click();
    const inviteUrl = await page
      .locator('[data-invite-link]')
      .getAttribute('data-invite-link');
    expect(inviteUrl).toBeTruthy();
    await page.keyboard.press('Escape');
    await waitForSynced(page);

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    await guest.goto(spaUrl(inviteUrl as string));
    await acceptInvite(guest);
    await guest.waitForURL(/\/app\//, { timeout: 15_000 });

    try {
      await expect(guest.getByText(hello)).toBeVisible({ timeout: 10_000 });
    } catch {
      // The invite may land outside the chat room.
      const chatHref = new URL('/app/show', FRONTEND_URL);
      chatHref.searchParams.set('subject', chatSubject);
      await guest.goto(chatHref.href);
      await expect(guest.getByText(hello)).toBeVisible({ timeout: 15_000 });
    }

    // The owner is in the app, but somewhere else.
    await page.goto(new URL('/app/settings', FRONTEND_URL).href);
    await expect(
      page.getByRole('heading', { name: 'Settings', exact: true }),
    ).toBeVisible();

    const inApp = `Are you there? ${timestamp()}`;
    await send(guest, inApp);

    const toast = page.getByRole('button', { name: /in Notify Chat/ });
    await expect(toast).toBeVisible({ timeout: 20_000 });
    await expect(toast).toContainText(inApp);
    await toast.click();
    await expect(
      page.getByRole('heading', { name: 'Notify Chat' }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(chatInput(page)).toBeVisible();

    // Looking at the chat itself: nothing to announce.
    const whileLooking = `You are looking ${timestamp()}`;
    await send(guest, whileLooking);
    await expect(page.getByText(whileLooking).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole('button', { name: /in Notify Chat/ }),
    ).toHaveCount(0);

    // The owner switches to another window: the OS shows it instead.
    await page.evaluate(() => (window.__blurred = true));
    const away = `Come back ${timestamp()}`;
    await send(guest, away);
    await expect
      .poll(() => page.evaluate(() => window.__osNotifications), {
        timeout: 20_000,
      })
      .toContainEqual({
        title: expect.stringContaining('Notify Chat'),
        body: away,
      });

    await guestContext.close();
  });
});
