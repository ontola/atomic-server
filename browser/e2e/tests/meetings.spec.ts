import { test, expect, type Page } from '@playwright/test';
import {
  before,
  getCurrentSubject,
  getDevDriveSecret,
  signIn,
  FRONTEND_URL,
} from './test-utils';

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
// Once a meeting is live the banner (by title) is the Join / open-chat control —
// unambiguous vs. the sidebar's meeting resource item (same name).
const joinBanner = (page: Page) => page.getByTitle(/led by/);
const meetingBanner = (page: Page) =>
  page.getByTitle(/led by|Open the meeting chat/);

test('top-bar Meet starts a meeting and opens its panel', async ({ page }) => {
  await before({ page });
  await page.waitForLoadState('load');

  const initialSubject = await getCurrentSubject(page);
  await page
    .getByRole('button', { name: 'Meet', exact: true })
    .click({ timeout: 30_000 });

  await expect(page.getByText('notes', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId('follow-session-panel')).toHaveAttribute(
    'data-open',
    '',
    { timeout: 30_000 },
  );

  const firstMeeting = await getCurrentSubject(page);
  expect(firstMeeting).not.toBe(initialSubject);

  await page.getByRole('button', { name: 'End meeting' }).click();
  await expect(
    page.getByText('minutes', { exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Meet', exact: true })
    .click({ timeout: 30_000 });

  await expect(page.getByText('notes', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  expect(await getCurrentSubject(page)).not.toBe(firstMeeting);
});

test('prepare an agenda, start it, and preserve minutes', async ({ page }) => {
  test.setTimeout(90_000);
  await before({ page });
  await page.waitForLoadState('load');

  await page.getByRole('button', { name: 'New Meeting' }).first().click();
  await expect(page.getByText('agenda', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  const meeting = await getCurrentSubject(page);
  expect(meeting).toBeTruthy();
  const agendaText = 'Approve launch plan';
  await page.getByLabel('Rich Text Editor').fill(agendaText);
  await expect(page.getByText(agendaText)).toBeVisible();

  expect(
    await page.evaluate(subject => {
      const store = window.store;
      const drive = store.getDrive();

      if (!drive) return false;

      const resource = store.getResourceLoading(drive);
      const live = (resource.get(
        'https://atomicdata.dev/properties/currentMeetings',
      ) ?? []) as string[];

      return live.includes(subject!);
    }, meeting),
  ).toBe(false);

  await page.getByRole('button', { name: 'Start meeting' }).click();
  await expect(page.getByText('notes', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('follow-session-panel')).toHaveAttribute(
    'data-open',
    '',
  );
  await expect(page.getByText(agendaText)).toBeVisible();

  await page.getByRole('button', { name: 'End meeting' }).click();
  await expect(
    page.getByText('minutes', { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText(agendaText)).toBeVisible();
});

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

  // 1. A quick-starts from More. It navigates to the dedicated Meeting page,
  // labels the shared body Notes, and opens that same Meeting's chat.
  await pageA.getByRole('button', { name: 'More' }).click();
  await pageA.getByTestId('menu-item-meeting').click();
  await expect(pageA.getByText('notes', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(pageA.getByTestId('follow-session-panel')).toHaveAttribute(
    'data-open',
    '',
    { timeout: 30_000 },
  );

  // 2. B sees the Join banner (title carries "led by") and clicks it.
  await expect(joinBanner(pageB)).toBeVisible({ timeout: 30_000 });
  await joinBanner(pageB).click();

  // The meeting chat opens with the start marker.
  const followerPanel = pageB.getByTestId('follow-session-panel');
  await expect(followerPanel).toHaveAttribute('data-open', '', {
    timeout: 30_000,
  });
  await expect(followerPanel.getByText('Started the meeting.')).toBeVisible({
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

  // 4. A ends the meeting from its panel header. Starting a meeting opens the
  // panel, and it stays open while navigating.
  const endButton = pageA.getByRole('button', { name: 'End', exact: true });
  await expect(endButton).toBeVisible({ timeout: 30_000 });
  await endButton.click();

  // The chat shows the end marker and B's meeting banner is gone.
  await expect(pageB.getByText('The meeting has ended.')).toBeVisible({
    timeout: 30_000,
  });
  await pageA
    .getByTestId('follow-session-panel')
    .getByRole('link', { name: 'Open notes' })
    .click();
  await expect(pageA.getByText('minutes', { exact: true }).first()).toBeVisible(
    {
      timeout: 30_000,
    },
  );
  await expect(meetingBanner(pageB)).toHaveCount(0, { timeout: 30_000 });

  await ctxA.close();
  await ctxB.close();
});

test('records join and leave in the meeting chat', async ({ browser }) => {
  test.setTimeout(120_000);

  // Leader A on the dev drive.
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await before({ page: pageA });
  await pageA.waitForLoadState('load');
  const drive = await pageA.evaluate(() => window.store.getDrive());
  const secret = await getDevDriveSecret(pageA);
  await pageA.goto(
    `${FRONTEND_URL}/app/show?subject=${encodeURIComponent(drive!)}`,
  );

  // Follower B: same agent, fresh context (no leader state of its own).
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto(FRONTEND_URL);
  await signIn(pageB, secret);
  await pageB.goto(
    `${FRONTEND_URL}/app/show?subject=${encodeURIComponent(drive!)}`,
  );

  // Presence is live between the two sessions.
  await expect(facepile(pageB).getByRole('button').first()).toBeVisible({
    timeout: 30_000,
  });

  // A starts a meeting; its chat panel opens.
  await pageA.getByRole('button', { name: 'More' }).click();
  await pageA.getByTestId('menu-item-meeting').click();
  const leaderPanel = pageA.getByTestId('follow-session-panel');
  await expect(leaderPanel).toHaveAttribute('data-open', '', {
    timeout: 30_000,
  });

  // B joins from the top-bar banner.
  await expect(joinBanner(pageB)).toBeVisible({ timeout: 30_000 });
  await joinBanner(pageB).click();
  const followerPanel = pageB.getByTestId('follow-session-panel');
  await expect(followerPanel.getByText('Started the meeting.')).toBeVisible({
    timeout: 30_000,
  });

  // Joining is recorded as a follow-event, and syncs to the leader's chat.
  await expect(leaderPanel.getByText('Joined the meeting.')).toBeVisible({
    timeout: 30_000,
  });

  // B leaves from the panel header while the meeting is still live.
  await pageB.getByRole('button', { name: 'Leave', exact: true }).click();

  // Leaving is recorded too (it is filtered only when the meeting has ended).
  await expect(leaderPanel.getByText('Left the meeting.')).toBeVisible({
    timeout: 30_000,
  });

  await ctxA.close();
  await ctxB.close();
});
