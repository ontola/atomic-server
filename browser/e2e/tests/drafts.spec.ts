import { test, expect } from '@playwright/test';
import {
  before,
  contextMenuClick,
  editableTitle,
  editTitle,
  getCurrentSubject,
  openSubject,
  newResource,
} from './test-utils';

/**
 * The draft flow end to end against a real server: Edit as draft forks a
 * resource, editing the draft leaves the original alone, and Merge writes the
 * draft's change back onto the original. Also exercises the `drafts` ontology
 * being seeded on the server and in the WASM client store.
 *
 * Concurrent-merge correctness (three-way, conflict detection) is covered
 * deterministically by the unit tests in `@tomic/lib` — `drafts.test.ts`.
 */
test.describe('drafts', () => {
  test.beforeEach(before);

  test('edit as draft, then merge, applies the change to the original', async ({
    page,
  }) => {
    await newResource('folder', page);
    await editTitle('Original Cheese', page);
    const originalSubject = await getCurrentSubject(page);

    // Fork it. Lands on the draft's normal view with the draft bar above it.
    await contextMenuClick('editAsDraft', page);
    await expect(page.getByText('Draft of')).toBeVisible();

    const draftSubject = await getCurrentSubject(page);
    expect(draftSubject).not.toBe(originalSubject);

    // The original is untouched while the draft is edited.
    await editTitle('Revised Cheese', page);

    // Merge from the draft bar.
    await page.getByRole('button', { name: 'Merge' }).click();

    // Back on the original, now carrying the draft's title, with no draft bar.
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(originalSubject)));
    await expect(editableTitle(page)).toHaveText('Revised Cheese');
    await expect(page.getByText('Draft of')).toBeHidden();
  });

  test('the original shows the drafts that propose changes to it', async ({
    page,
  }) => {
    await newResource('folder', page);
    await editTitle('Reviewable', page);
    const originalSubject = await getCurrentSubject(page);

    await contextMenuClick('editAsDraft', page);
    await expect(page.getByText('Draft of')).toBeVisible();
    await editTitle('Proposed rename', page);

    // A reviewer opening the original discovers the draft with no inbox — a
    // reverse query over the drive, surfaced above the resource.
    await openSubject(page, originalSubject);
    await expect(
      page.getByText('1 draft proposes a change to this'),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Proposed rename' }),
    ).toBeVisible();
  });

  test('discard removes the draft and returns to the original', async ({
    page,
  }) => {
    await newResource('folder', page);
    await editTitle('Keep Me', page);
    const originalSubject = await getCurrentSubject(page);

    await contextMenuClick('editAsDraft', page);
    await expect(page.getByText('Draft of')).toBeVisible();
    const draftSubject = await getCurrentSubject(page);

    await page.getByRole('button', { name: 'Discard' }).click();

    // Back on the original, unchanged, and the draft is gone.
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(originalSubject)));
    await expect(editableTitle(page)).toHaveText('Keep Me');
    await expect(page.getByText('Draft of')).toBeHidden();
    expect(draftSubject).not.toBe(originalSubject);
  });

  // A document's text lives in a Loro `doc` container, not in propvals, so its
  // draft carries a `forkVersion` and the merge is a CRDT body merge — not the
  // three-way propval squash the other tests exercise. The draft bar must offer
  // Merge on the strength of the body alone (no changed property), and the
  // body edit must land on the original.
  test('edit a document body as a draft, then merge, applies the body edit', async ({
    page,
  }) => {
    test.slow();

    await newResource('document', page);
    await editTitle('Manifesto', page);
    const originalSubject = await getCurrentSubject(page);

    await expect(page.getByText('loading...')).not.toBeVisible();
    const editor = page.getByLabel('Rich Text Editor');
    await expect(editor).toBeVisible({ timeout: 30000 });
    await editor.click();
    await page.keyboard.type('The seed line.');
    await expect(page.getByText('The seed line.')).toBeVisible();

    // Fork the document. The draft renders through the same document view, its
    // body seeded from the original, with the draft bar above it.
    await contextMenuClick('editAsDraft', page);
    await expect(page.getByText('Draft of')).toBeVisible();
    const draftSubject = await getCurrentSubject(page);
    expect(draftSubject).not.toBe(originalSubject);

    // The seeded body came along.
    const draftEditor = page.getByLabel('Rich Text Editor');
    await expect(draftEditor).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('The seed line.')).toBeVisible();

    // Add a paragraph on the draft only.
    await draftEditor.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Added on the draft.');
    await expect(page.getByText('Added on the draft.')).toBeVisible();

    // No propval changed — Merge is offered purely because the body did.
    const mergeButton = page.getByRole('button', { name: 'Merge' });
    await expect(mergeButton).toBeEnabled();
    await mergeButton.click();

    // Back on the original, now carrying the draft's body edit, no draft bar.
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(originalSubject)));
    await expect(page.getByText('Draft of')).toBeHidden();
    await expect(page.getByText('The seed line.')).toBeVisible();
    await expect(page.getByText('Added on the draft.')).toBeVisible();
  });
});
