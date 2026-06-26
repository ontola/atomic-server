import { test } from '@playwright/test';
import { signIn, editProfileAndCommit, FRONTEND_URL } from './test-utils';

test('debug: instrument profile-edit flow', async ({ page }) => {
  const adReqs: string[] = [];
  const errors: string[] = [];
  page.on('request', r => {
    if (r.url().includes('atomicdata.dev')) adReqs.push(r.url());
  });
  page.on('console', m => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 160));
  });

  await page.goto(FRONTEND_URL);
  await signIn(page);

  // inspect the agent's clientDb state right after an edit (before reload)
  const probe = await page.evaluate(async () => {
    const s = window.store;
    const NAME = 'https://atomicdata.dev/properties/name';
    const subj = s.getAgent()?.subject;
    if (!subj) return { error: 'no agent' };
    const r = await s.getResource(subj);
    await r.set(NAME, 'DebugEdit-123', s);
    await r.save(s);
    await new Promise(res => setTimeout(res, 2500));
    const local = await s.fetchResourceFromClientDb(subj);
    return { subj, localName: local?.get?.(NAME) };
  });

  // eslint-disable-next-line no-console
  console.log(
    'DEBUG',
    JSON.stringify({
      probe,
      atomicdataRequests: adReqs.slice(0, 8),
      adReqCount: adReqs.length,
      consoleErrors: errors.slice(0, 8),
    }),
  );
});
