import { test, expect } from './fixtures';
import { before, FRONTEND_URL } from './test-utils';

test('manage multiple drives without deleting content, and restore after reload', async ({
  page,
}) => {
  await before({ page });
  const projects = await page.evaluate(async () => {
    const alpha = await window.store.createDrive('Project alpha', {
      personal: false,
    });
    const beta = await window.store.createDrive('Project beta', {
      personal: false,
    });

    return [alpha.subject, beta.subject];
  });
  await page.goto(`${FRONTEND_URL}/app/agent`);
  const list = page.getByTestId('my-drives');
  await expect(
    list.getByRole('radio', { name: 'Project alpha', exact: true }),
  ).toBeVisible();
  await expect(
    list.getByRole('radio', { name: 'Project beta', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    list.getByRole('radio', { name: 'Project alpha', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Manage drives', exact: true })
    .click();
  await expect(list.getByRole('checkbox', { name: /Private/ })).toBeDisabled();
  await expect(
    list.getByRole('button', { name: 'Drive actions', exact: true }),
  ).toHaveCount(2);
  await list
    .getByRole('button', { name: 'Drive actions', exact: true })
    .first()
    .click();
  await expect(
    page.getByRole('menuitem', { name: 'Move to Trash', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('menuitem', { name: 'Delete permanently', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText('Project alpha');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await page
    .getByRole('button', { name: 'Remove selected (2)', exact: true })
    .click();
  const confirmation = page.getByRole('dialog');
  await expect(confirmation).toContainText('Project alpha');
  await expect(confirmation).toContainText('Project beta');
  await expect(confirmation).toContainText(projects[0]);
  await expect(confirmation.getByRole('radio')).toHaveCount(0);
  await expect(confirmation.getByRole('checkbox')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Remove from list', exact: true })
    .click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.reload();
  await expect(list.getByRole('radio')).toHaveCount(1);
  await page.getByText('Removed from My drives (2)', { exact: true }).click();
  await expect(
    page.getByRole('radio', { name: /Project alpha|Project beta/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Restore', exact: true }),
  ).toHaveCount(2);
  await page
    .getByRole('button', { name: 'Restore', exact: true })
    .first()
    .click();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(
    list.getByRole('radio', { name: 'Project alpha', exact: true }),
  ).toBeVisible();
  await expect(
    list.getByRole('radio', { name: 'Project beta', exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        async subjects =>
          Promise.all(
            subjects.map(async subject => {
              const resource = await window.store.getResource(subject);

              return resource.get('https://atomicdata.dev/properties/name');
            }),
          ),
        projects,
      ),
    )
    .toEqual(['Project alpha', 'Project beta']);
});
