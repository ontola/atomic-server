import { test, expect } from '@playwright/test';
import { devDrive } from './test-utils';

// Regression for the ClientDb edit-persistence fix (store.ts drain re-persist):
// a local edit must reach OPFS, not just the server, so a reload reflects it.
// Before the fix `editNameLocal` stayed at the pre-edit value.
test('edit persists to local ClientDb across the drain', async ({ page }) => {
  await devDrive(page);

  const result = await page.evaluate(async () => {
    const s = window.store;
    const drive =
      document.querySelector('main[about]')?.getAttribute('about') ?? undefined;
    const NAME = 'https://atomicdata.dev/properties/name';
    const FOLDER = 'https://atomicdata.dev/classes/Folder';

    const tmp = await s.createSubject('persist-test');
    const r = await s.newResource({ subject: tmp, parent: drive, isA: FOLDER });
    await r.set(NAME, 'PersistProbe-A', s);
    await r.save(s);
    const realSubject = r.subject;
    await new Promise(res => setTimeout(res, 1500));
    const afterCreate = await s.fetchResourceFromClientDb(realSubject);

    const r2 = await s.getResource(realSubject);
    await r2.set(NAME, 'PersistProbe-B-EDITED', s);
    await r2.save(s);
    await new Promise(res => setTimeout(res, 2500));
    const afterEdit = await s.fetchResourceFromClientDb(realSubject);
    const srv = await s.fetchResourceFromServer(realSubject);

    return {
      createName: afterCreate?.get?.(NAME),
      editNameLocal: afterEdit?.get?.(NAME),
      editNameServer: srv?.get?.(NAME),
    };
  });

  expect(result.createName).toBe('PersistProbe-A');
  expect(result.editNameServer).toBe('PersistProbe-B-EDITED');
  expect(result.editNameLocal).toBe('PersistProbe-B-EDITED');
});
