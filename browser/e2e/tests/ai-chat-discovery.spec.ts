import { test, expect } from './fixtures';
import { before, getDevDriveSecret, signIn, FRONTEND_URL } from './test-utils';
import {
  enableAIForTesting,
  setupAIRouteMocks,
  sendChatMessage,
} from './ai-mock';
import { ai, core, dataBrowser } from '@tomic/lib';

test('AI chat discovery includes both duplicate folders and root chats, scoped to the private drive', async ({
  page,
}) => {
  await enableAIForTesting(page);
  await setupAIRouteMocks(page);
  await before({ page });
  const titles = await page.evaluate(
    async ({ aiClass, folderClass, name, pointer }) => {
      const store = window.store;
      const drive = await store.getResource(await store.privateDriveSubject());

      const make = async (parent: string, isA: string, title: string) => {
        const res = await store.newResource({
          parent,
          isA,
          propVals: { [name]: title },
        });
        await res.save();
        store.notifyResourceManuallyCreated(res);

        return res;
      };

      const first = await make(drive.subject, folderClass, 'AI Chats');
      const second = await make(drive.subject, folderClass, 'AI Chats');
      await drive.set(pointer, second.subject);
      await drive.save();
      await make(first.subject, aiClass, 'Phone conversation');
      await make(second.subject, aiClass, 'Desktop conversation');
      await make(drive.subject, aiClass, 'Legacy root conversation');
      await make(second.subject, folderClass, 'Not a conversation');
      const otherDrive = await store.createDrive('Other workspace', {
        personal: false,
        localOnly: true,
      });
      await make(otherDrive.subject, aiClass, 'Other drive conversation');

      return [
        'Phone conversation',
        'Desktop conversation',
        'Legacy root conversation',
      ];
    },
    {
      aiClass: ai.classes.aiChat,
      folderClass: dataBrowser.classes.folder,
      name: core.properties.name,
      pointer: ai.properties.aiChatsFolder,
    },
  );
  const panel = page.getByTestId('ai-chats-panel');

  for (const title of titles) {
    await expect(
      panel.getByRole('link', { name: title, exact: true }),
    ).toBeVisible();
  }

  await expect(
    panel.getByRole('link', { name: 'Other drive conversation' }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole('link', { name: 'Not a conversation' }),
  ).toHaveCount(0);
  await page.reload();

  for (const title of titles) {
    await expect(
      panel.getByRole('link', { name: title, exact: true }),
    ).toBeVisible();
  }
});

test('independent signed-in devices create chats in one deterministic folder', async ({
  page,
  browser,
}) => {
  await enableAIForTesting(page);
  await setupAIRouteMocks(page, { chatResponse: 'Phone answer' });
  await before({ page });
  const secret = await getDevDriveSecret(page);
  const context = await browser.newContext();
  const desktop = await context.newPage();

  try {
    await enableAIForTesting(desktop);
    await setupAIRouteMocks(desktop, { chatResponse: 'Desktop answer' });
    await desktop.goto(`${FRONTEND_URL}/app/welcome`);
    await signIn(desktop, secret);
    await desktop.goto(page.url());
    await expect(desktop.getByTestId('sidebar')).toBeVisible();
    await Promise.all([
      sendChatMessage(page, 'Phone conversation'),
      sendChatMessage(desktop, 'Desktop conversation'),
    ]);
    await expect(page.getByText('Phone answer', { exact: true })).toBeVisible();
    await expect(
      desktop.getByText('Desktop answer', { exact: true }),
    ).toBeVisible();
    const folder = async (target: typeof page) =>
      target.evaluate(async pointer => {
        const store = window.store;
        const drive = await store.privateDriveSubject();
        const expected = await store.getAgent()!.aiChatsFolderSubject(drive);

        return {
          expected,
          actual: (await store.getResource(drive)).get(pointer),
        };
      }, ai.properties.aiChatsFolder);
    await expect.poll(async () => (await folder(page)).actual).toBeTruthy();
    await expect.poll(async () => (await folder(desktop)).actual).toBeTruthy();
    const phone = await folder(page);
    const other = await folder(desktop);
    expect(phone.actual).toBe(phone.expected);
    expect(other.actual).toBe(phone.actual);
    expect(other.expected).toBe(phone.expected);
  } finally {
    await context.close();
  }
});
