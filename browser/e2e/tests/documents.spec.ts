import { test, expect } from '@playwright/test';
import {
  getDevDriveSecret,
  newResource,
  editTitle,
  getCurrentSubject,
  makeDrivePublic,
  openNewSubjectWindow,
  timestamp,
  before,
  setTitle,
  waitForSearchIndex,
} from './test-utils';

test.describe('documents', async () => {
  test.beforeEach(before);

  // FLAKY (dagger CI, intermittent on remote): multi-context CRDT sync
  // via the WS hub. Page2 sometimes doesn't see the page1 deletion of
  // "New paragraph" within 15s — pattern is `Locator: locator('text=New
  // paragraph')` Expected: not visible / Received: visible. Likely
  // exceeds the loro broadcast budget under dagger CPU contention.
  // Investigate: bump the assertion to `waitForFunction` polling on the
  // store's loro-doc state instead of DOM text.
  test('create document, edit, page title, websockets', async ({
    page,
    browser,
  }) => {
    page.on('console', msg => {
      console.log(`[page1-console] [${msg.type()}]`, msg.text());
    });
    // The multi-user flow opens a second context, signs in, syncs, edits,
    // and waits for cross-tab WS propagation — frequently bumps past the
    // 30s default under suite-wide load.
    test.slow();
    const folderTitle = 'SomeFolder';

    const secret = await getDevDriveSecret(page);
    await makeDrivePublic(page);
    await newResource('folder', page);
    await setTitle(page, folderTitle);
    await newResource('document', page);
    const title = `Document ${timestamp()}`;
    await editTitle(title, page);

    const teststring = `My test: ${timestamp()}`;

    await expect(page.getByText('loading...')).not.toBeVisible();

    const editor = page.getByLabel('Rich Text Editor');

    await editor.fill('/heading');
    await expect(page.getByText('Heading 1')).toBeVisible();
    await page.keyboard.press('Enter');
    await page.keyboard.type(teststring);

    await expect(page.getByRole('heading', { name: teststring })).toBeVisible();

    // multi-user
    const currentSubject = await getCurrentSubject(page);
    const page2 = await openNewSubjectWindow(browser, currentSubject!, secret);
    page2.on('console', msg => {
      console.log(`[page2-console] [${msg.type()}]`, msg.text());
    });

    // "Set Drive" historically appeared when opening a foreign-drive subject;
    // proper sign-in already sets the drive, so the button often isn't there.
    // Click only when present, ignore otherwise.
    const setDriveButton = page2.getByRole('button', { name: 'Set Drive' });

    if (await setDriveButton.isVisible({ timeout: 1500 }).catch(() => false)) {
      await setDriveButton.click();
    }

    // Sidebar may still show loading placeholders for unrelated children;
    // scope to `main` so we only wait for the document body to land. Bumped
    // timeout because the second tab needs WS auth + initial sync.
    await expect(
      page2.getByRole('main').getByText(/^loading/i),
    ).not.toBeVisible({ timeout: 15000 });
    await expect(
      page2.getByRole('heading', { name: teststring }),
      'First paragraph title not visible in second tab. Not a websocket issue',
    ).toBeVisible({ timeout: 15000 });
    expect(await page2.title()).toEqual(title);

    await page2.getByLabel('Rich Text Editor').focus();
    await page2.keyboard.press('ArrowDown');
    await page2.waitForTimeout(50);
    await page2.keyboard.press('Enter');
    const syncText = 'New paragraph';
    await page2.keyboard.type(syncText);

    await expect(
      page2.locator(`text=${syncText}`),
      'New paragraph not found after typing. Something is wrong with rendering the text / handling the keyboard.',
    ).toBeVisible();

    await expect(
      page.locator(`text=${syncText}`),
      'New paragraph not found in first window. Sync might not be working.',
    ).toBeVisible();

    // Test if page1 can see the cursor of page2
    await page2.getByText(syncText).selectText();

    // Not sure what this is supposed to do, but this text does not show up.
    // Perhaps I need 2 differetn agents?
    // await expect(
    //   page.getByLabel('Rich Text Editor').getByText('Test user edited'),
    // ).toBeVisible();

    // Delete the typed text. `Alt+Backspace` only deletes-word on macOS;
    // headless chromium on Linux (dagger CI) treats it as a no-op, so the
    // paragraph stayed and the cross-tab "not visible" assertion timed
    // out. Re-select-then-Backspace deletes the selection deterministically
    // on every platform.
    await page2.getByText(syncText).selectText();
    await page2.keyboard.press('Backspace');

    // Loro CRDT sync between two browser contexts goes through the server's
    // WS hub, so propagation can take several seconds under suite-wide load.
    // Verify the local deletion first, then poll for the cross-tab sync.
    await expect(
      page2.locator(`text=${syncText}`),
      'Paragraph not deleted in second window',
    ).not.toBeVisible({ timeout: 15000 });
    await expect(
      page.locator(`text=${syncText}`),
      'Paragraph not deleted in first window.',
    ).not.toBeVisible({ timeout: 15000 });

    // Wait for AtomicServer to index the folder so the @-mention can find it.
    await waitForSearchIndex(page2);
    // Add a link to a folder via @ mention
    await page2.keyboard.press('Space');
    await page2.keyboard.type('@');
    // The RTE command list mounts asynchronously after `@` is typed.
    // Wait for it instead of guessing a fixed delay.
    await expect(page2.getByTestId('rte-command-list')).toBeVisible({
      timeout: 10000,
    });
    await page2.keyboard.type(folderTitle, { delay: 50 });
    await expect(
      page2.getByTestId('rte-command-list').getByText(folderTitle),
    ).toBeVisible();
    await page2.keyboard.press('Enter');

    // Cross-tab CRDT sync of the @-mention link can take a few seconds.
    await expect(
      page.getByLabel('Rich Text Editor').locator('a:has-text("SomeFolder")'),
    ).toBeVisible({ timeout: 15000 });
  });

  // Ephemeral Loro cursor (presence): a collaborator's caret position is
  // broadcast over the WS hub as a `LORO_EPHEMERAL_UPDATE` frame (not
  // persisted), and loro-prosemirror renders it in the other tab's editor as a
  // `.ProseMirror-loro-cursor` decoration carrying the peer's color + name.
  //
  // FIXME: currently parked because the CollaborativeEditor crashes on load for
  // this flow with `Cannot read properties of undefined (reading 'eq')` in
  // prosemirror-view's `DecorationGroup.eq`. Trigger: a tiptap v3 React menu
  // component (BubbleMenu/DragHandle/FloatingHint) registers/unregisters a
  // ProseMirror plugin via a passive effect (double-invoked under StrictMode);
  // the reconfigure's `view.updateState` diffs the decoration groups while the
  // loro ephemeral-cursor plugin is contributing decorations, and a changed
  // DecorationGroup membership dereferences an undefined member. This is the
  // same tiptap-version incompatibility that had the cursor disabled before.
  // Un-`fixme` once the RTE crash is fixed — the assertions below are correct.
  test.fixme('shows a collaborator’s ephemeral cursor position', async ({
    page,
    browser,
  }) => {
    test.slow();

    const secret = await getDevDriveSecret(page);
    await makeDrivePublic(page);
    await newResource('document', page);
    await editTitle(`Cursor Doc ${timestamp()}`, page);

    await expect(page.getByText('loading...')).not.toBeVisible();
    // The CollaborativeEditor is a lazy chunk; on a cold dev server its first
    // transform (React Compiler pass) can take >10s, so wait explicitly before
    // interacting rather than relying on the default action timeout.
    const editor1 = page.getByLabel('Rich Text Editor');
    await expect(editor1).toBeVisible({ timeout: 30000 });
    const sharedText = `Shared line ${timestamp()}`;
    await editor1.click();
    await page.keyboard.type(sharedText);
    await expect(page.getByText(sharedText)).toBeVisible();

    // Second user opens the same document and waits for the text to sync in.
    const subject = await getCurrentSubject(page);
    const page2 = await openNewSubjectWindow(browser, subject!, secret);

    const setDriveButton = page2.getByRole('button', { name: 'Set Drive' });

    if (await setDriveButton.isVisible({ timeout: 1500 }).catch(() => false)) {
      await setDriveButton.click();
    }

    await expect(
      page2.getByRole('main').getByText(/^loading/i),
    ).not.toBeVisible({ timeout: 15000 });
    await expect(page2.getByText(sharedText)).toBeVisible({ timeout: 15000 });

    // page2 places its caret inside the shared text. The selection change makes
    // loro-prosemirror set the local ephemeral cursor, which is broadcast.
    await page2.getByText(sharedText).click();
    await page2.keyboard.press('ArrowLeft');

    // page1 must render page2's remote caret. Use `toBeAttached` (not
    // `toBeVisible`): a collapsed remote caret is a thin/zero-width decoration
    // span, so presence in the DOM — not a bounding box — is the correct signal
    // that the ephemeral cursor synced and was positioned.
    const remoteCursor = page.locator('.ProseMirror-loro-cursor');
    await expect(
      remoteCursor.first(),
      'page1 did not render the collaborator’s ephemeral cursor',
    ).toBeAttached({ timeout: 15000 });

    // Exactly one remote peer → exactly one caret (ephemeral, not duplicated or
    // persisted into the doc), and it carries the peer's color via inline style.
    await expect(remoteCursor).toHaveCount(1);
    await expect(remoteCursor).toHaveAttribute('style', /border-color/);
  });
});
