import { test, expect, type Page } from '@playwright/test';
import { before, getDevDriveSecret, signIn, FRONTEND_URL } from './test-utils';

/**
 * Meetings (#1127): follow-mode with a front door, driven as two
 * sessions (browser contexts) of the same agent in one drive.
 *
 * 1. Leader A starts a meeting from the drive menu.
 * 2. Follower B sees the top-bar Join banner and clicks it → follows A
 *    and the meeting chat opens, showing the "Started the meeting."
 *    marker.
 * 3. A navigates to a folder → B is taken along, and the visit is
 *    logged as a trail entry in the meeting chat.
 * 4. A ends the meeting → the chat shows "The meeting has ended." and
 *    B's Join banner disappears.
 */

const facepile = (page: Page) =>
  page.locator('[aria-label="Also viewing this resource"]');
// Nav-bar affordances. The "Meet" button starts a meeting; once one is
// live the banner (by title) is the Join / open-chat control —
// unambiguous vs. the sidebar's meeting resource item (same name).
const meetButton = (page: Page) =>
  page.getByRole('button', { name: 'Meet', exact: true });
const joinBanner = (page: Page) => page.getByTitle(/led by/);
const meetingBanner = (page: Page) =>
  page.getByTitle(/led by|Open the meeting chat/);

test('start a meeting, join it, follow along, and end it', async ({
  browser,
}) => {
  test.setTimeout(120_000);

  // --- Session A (the leader): dev drive + a folder to navigate to ---
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await before({ page: pageA });
  await pageA.waitForLoadState('load');

  let created!: { drive: string; folder: string };
  await expect(async () => {
    created = await pageA.evaluate(async () => {
      const s = window.store;
      const d = s.getDrive();

      if (!d) throw new Error('no drive');

      const tmp = await s.createSubject('meeting-e2e');
      const f = await s.newResource({
        subject: tmp,
        parent: d,
        isA: 'https://atomicdata.dev/classes/Folder',
      });
      await f.set(
        'https://atomicdata.dev/properties/name',
        'MeetingTarget',
        false,
      );
      await f.save();

      return { drive: d, folder: f.subject };
    });
  }).toPass({ timeout: 30_000 });
  const { drive, folder } = created;
  const secret = await getDevDriveSecret(pageA);

  await pageA.goto(
    `${FRONTEND_URL}/app/show?subject=${encodeURIComponent(drive)}`,
  );

  // --- Session B (the follower): same agent, fresh context ---
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto(FRONTEND_URL);
  await signIn(pageB, secret);
  await pageB.goto(
    `${FRONTEND_URL}/app/show?subject=${encodeURIComponent(drive)}`,
  );

  // Both sessions see each other — presence is live.
  await expect(facepile(pageB).getByRole('button').first()).toBeVisible({
    timeout: 30_000,
  });

  // 1. A starts a meeting from the nav-bar "Meet" button (no title
  // prompt — it gets a dated name A can rename later).
  await expect(meetButton(pageA)).toBeVisible({ timeout: 30_000 });
  await meetButton(pageA).click();

  // 2. B sees the Join banner (title carries "led by") and clicks it.
  await expect(joinBanner(pageB)).toBeVisible({ timeout: 30_000 });
  await joinBanner(pageB).click();

  // The meeting chat opens with the start marker.
  await expect(
    pageB.getByRole('heading', { name: 'Meeting' }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(pageB.getByText('Started the meeting.')).toBeVisible({
    timeout: 30_000,
  });

  // 3. A navigates; B follows along and the trail logs the visit.
  await pageA.getByRole('button', { name: 'MeetingTarget' }).first().click();
  await expect(pageB).toHaveURL(
    new RegExp(
      encodeURIComponent(folder).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    ),
    { timeout: 30_000 },
  );
  await expect(
    pageB
      .getByTestId('follow-session-panel')
      .getByRole('link', { name: 'MeetingTarget' }),
  ).toBeVisible({ timeout: 30_000 });

  // 4. A ends the meeting: open its own meeting chat (active banner),
  // then End from the panel header.
  await pageA.getByTitle('Open the meeting chat').click();
  await pageA.getByRole('button', { name: 'End', exact: true }).click();

  // The chat shows the end marker and B's meeting banner is gone.
  await expect(pageB.getByText('The meeting has ended.')).toBeVisible({
    timeout: 30_000,
  });
  await expect(meetingBanner(pageB)).toHaveCount(0, { timeout: 30_000 });

  await ctxA.close();
  await ctxB.close();
});
