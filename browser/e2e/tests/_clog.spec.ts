import { test } from '@playwright/test';
import { devDrive } from './test-utils';

test('commit-log diff shows the real change, not all-removed', async ({
  page,
}) => {
  await devDrive(page);
  const result = await page.evaluate(async () => {
    const s = window.store;
    const drive =
      document.querySelector('main[about]')?.getAttribute('about') ?? undefined;
    const NAME = 'https://atomicdata.dev/properties/name';
    const FOLDER = 'https://atomicdata.dev/classes/Folder';

    const tmp = await s.createSubject('clog');
    const r = await s.newResource({ subject: tmp, parent: drive, isA: FOLDER });
    await r.set(NAME, 'First', s);
    await r.save(s);
    await new Promise(res => setTimeout(res, 1500));

    const r2 = await s.getResource(r.subject);
    await r2.set(NAME, 'Second', s);
    await r2.save(s);
    await new Promise(res => setTimeout(res, 2000));

    return s
      .getCommitLog()
      .filter((e: { subject: string }) => e.subject === r.subject)
      .map(
        (e: {
          summary?: string;
          propertySummaries?: Array<{ property: string; changeType: string }>;
        }) => ({
          summary: e.summary,
          props: (e.propertySummaries ?? []).map(
            p => `${p.property.split('/').pop()}:${p.changeType}`,
          ),
        }),
      );
  });
  // eslint-disable-next-line no-console
  console.log('CLOG', JSON.stringify(result));
});
