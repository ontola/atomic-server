import fs from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import {
  devDrive,
  editableTitle,
  getCurrentSubject,
  newResource,
  waitForSynced,
  FRONTEND_URL,
} from '../tests/test-utils';

export const ME = 'Alex Morgan';
export const DRIVE = 'Acme team';

/** The Tasks rows. Fixed, so the board and what the chats say about it agree. */
export const TASKS = [
  {
    name: 'Design onboarding flow',
    status: 'doing',
    who: 'Priya Nair',
    due: '2026-10-29',
    est: 8,
  },
  {
    name: 'Write pricing page copy',
    status: 'blocked',
    who: 'Sarah Klein',
    due: '2026-10-30',
    est: 3,
    body: 'Waiting for legal to approve the plan wording.',
  },
  {
    name: 'Update terms of service',
    status: 'blocked',
    who: 'Sarah Klein',
    due: '2026-10-28',
    est: 2,
    body: 'Legal still has to sign off on the new terms.',
  },
  {
    name: 'Book kickoff venue',
    status: 'todo',
    who: 'Tom Visser',
    due: '2026-10-28',
    est: 2,
  },
  {
    name: 'Set up analytics dashboard',
    status: 'doing',
    who: 'Marc de Vries',
    due: '2026-10-30',
    est: 5,
  },
  {
    name: 'Draft launch announcement',
    status: 'todo',
    who: ME,
    due: '2026-11-03',
    est: 5,
  },
  {
    name: 'Synthesize customer interviews',
    status: 'done',
    who: 'Priya Nair',
    due: '2026-10-22',
    est: 3,
  },
  {
    name: 'Prepare demo environment',
    status: 'done',
    who: 'Marc de Vries',
    due: '2026-10-24',
    est: 2,
  },
];

/** A fresh agent called Alex Morgan, signed in to a fresh drive called Acme team. */
export async function acmeDrive(page: Page): Promise<string> {
  await devDrive(page);
  const drive = await getCurrentSubject(page);
  await page.evaluate(
    async ({ me, driveSubject, driveName }) => {
      const store = window.store;
      const agent = await store.getResource(store.getAgent()!.subject);
      await agent.set('https://atomicdata.dev/properties/name', me);
      await agent.save();
      const driveRes = await store.getResource(driveSubject);
      await driveRes.set('https://atomicdata.dev/properties/name', driveName);
      await driveRes.save();
    },
    { me: ME, driveSubject: drive, driveName: DRIVE },
  );
  await waitForSynced(page);

  return drive;
}

/** The Tasks table from the Project tasks template, filled with {@link TASKS}. */
export async function tasksTable(page: Page): Promise<string> {
  await newResource('table', page);
  await page
    .locator('dialog[open]')
    .getByRole('button', { name: /Project tasks/ })
    .click();
  await page.getByPlaceholder('New Table').fill('Tasks');
  await page
    .locator('dialog[open]')
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Tasks' }).first(),
  ).toBeVisible({ timeout: 60_000 });
  const table = await getCurrentSubject(page);

  await page.evaluate(
    async ({ tableSubject, tasks }) => {
      const store = window.store;
      const tableRes = await store.getResource(tableSubject);
      const cls = tableRes.get(
        'https://atomicdata.dev/properties/classtype',
      ) as string;
      const classRes = await store.getResource(cls);
      const props =
        (classRes.get(
          'https://atomicdata.dev/properties/recommends',
        ) as string[]) ?? [];
      const estimate = props.find(p => p.startsWith('atomic:prop:'))!;
      const base = 'https://atomicdata.dev/task/v1/';
      let i = 0;

      for (const t of tasks) {
        const row = await store.newResource({
          parent: tableSubject,
          isA: cls,
          propVals: {
            'https://atomicdata.dev/properties/name': t.name,
            'https://atomicdata.dev/properties/createdAt': Date.now() + i++,
            [`${base}status`]: [`${base}${t.status}`],
            [`${base}assignee`]: t.who,
            [`${base}due-date`]: t.due,
            [estimate]: t.est,
            ...(t.body ? { [`${base}body`]: t.body } : {}),
          },
        });
        await row.save();
      }
    },
    { tableSubject: table, tasks: TASKS },
  );
  await waitForSynced(page);
  await page.goto(
    `${FRONTEND_URL}/app/show?subject=${encodeURIComponent(table)}`,
  );

  return table;
}

/** Open a resource in the app. */
export async function open(page: Page, subject: string) {
  await page.goto(
    `${FRONTEND_URL}/app/show?subject=${encodeURIComponent(subject)}`,
  );
}

/** Give the open resource a new title, the way a person does: click it and type. */
export async function rename(page: Page, title: string) {
  // Retried as a whole: typing too early, before the page takes input, is lost.
  await expect(async () => {
    // A canvas has no title of its own on the page, only in the breadcrumbs.
    await editableTitle(page)
      .or(page.getByTitle('Click to rename'))
      .first()
      .click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type(title);
    await page.keyboard.press('Enter');
    await expect(page.getByText(title, { exact: true }).first()).toBeVisible({
      timeout: 4_000,
    });
  }).toPass({ timeout: 40_000 });
}

/**
 * Create a resource under `parent` from the New page and open it. `label` is
 * the button on that page ("Folder", "Document", "Meeting", "Canvas", ...).
 */
export async function createIn(
  page: Page,
  parent: string,
  label: string,
): Promise<string> {
  await waitForSynced(page);
  await page.goto(
    `${FRONTEND_URL}/app/new?parentSubject=${encodeURIComponent(parent)}`,
  );
  await page
    .getByRole('main')
    .locator('section')
    .getByRole('button', { name: label, exact: true })
    .click();
  await expect(page).not.toHaveURL(/\/app\/new(\?|$)/, { timeout: 30_000 });

  return getCurrentSubject(page);
}

/** Name the open resource, then wait for it to be saved. */
export async function createNamed(
  page: Page,
  parent: string,
  label: string,
  title: string,
): Promise<string> {
  const subject = await createIn(page, parent, label);
  await rename(page, title);
  await waitForSynced(page);

  return subject;
}

/** The "Projects" folder with the "Q4 plan" document in it. */
export async function q4Plan(page: Page, drive: string) {
  const folder = await createNamed(page, drive, 'Folder', 'Projects');
  const doc = await createNamed(page, folder, 'Document', 'Q4 plan');
  const editor = page.getByLabel('Rich Text Editor');
  await editor.click();
  await page.keyboard.type('# Goals for Q4\n');
  await page.keyboard.type(
    'We want to ship the new onboarding flow, double the number of active drives and cut the time to first document in half. Every goal has an owner and a date.\n',
  );
  await page.keyboard.type('# Milestones\n- ');
  await page.keyboard.type(
    'Onboarding flow in beta by 15 October\nInvite links for shared folders\nOffline-first tables for the whole team\nPublic launch on 1 December',
  );
  await expect(page.getByText('Public launch on 1 December')).toBeVisible();
  await waitForSynced(page);

  return { folder, doc };
}

/** Describe the drive, like a person does in its settings. */
export async function describeDrive(page: Page, drive: string, text: string) {
  await page.evaluate(
    async ({ subject, description }) => {
      const res = await window.store.getResource(subject);
      await res.set(
        'https://atomicdata.dev/properties/description',
        description,
      );
      await res.save();
    },
    { subject: drive, description: text },
  );
  await waitForSynced(page);
}

/** Where the PNGs go: the docs assets, plus an optional second copy. */
const OUT_DIR =
  process.env.DOCS_SCREENSHOTS_OUT ??
  path.resolve(__dirname, '../../../docs/src/assets/app');
const COPY_DIR = process.env.DOCS_SCREENSHOTS_COPY_TO;

/** Wait until nothing is loading or saving, then write `name.png` (1440x900 @2x). */
export async function shot(
  page: Page,
  name: string,
  options?: Parameters<typeof capture>[2],
) {
  await settled(page);
  await capture(page, name, options);
}

/** Nothing loading, saving or syncing, and no toast. Call before opening a dialog or menu. */
export async function settled(page: Page) {
  await waitForSynced(page);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  // The sidebar's sync icon spins while the drive syncs.
  await expect(page.locator('svg:has(title:text-is("Connected"))')).toBeVisible(
    { timeout: 60_000 },
  );
  await expect(page.locator('[data-rht-toaster] > div')).toHaveCount(0);
}

/** Write `name.png` from the page as it is, for shots with a dialog or menu open. */
export async function capture(
  page: Page,
  name: string,
  {
    blur = true,
    mouse = [1430, 890],
  }: { blur?: boolean; mouse?: [number, number] } = {},
) {
  // A menu closes when it loses focus, so a shot of one keeps the focus where it is.
  if (blur)
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );

  await page.mouse.move(...mouse);
  await page.waitForTimeout(800);
  const png = await page.screenshot();

  for (const dir of [OUT_DIR, COPY_DIR].filter((d): d is string => !!d)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.png`), png);
  }
}

/** Point the app's AI at a local Ollama, the way a person would in the settings. */
export async function seedAISettings(page: Page) {
  await page.addInitScript(() => {
    if (!location.protocol.startsWith('http')) return;
    const set = (key: string, value: unknown) =>
      localStorage.setItem(key, JSON.stringify(value));
    set('atomic.ai.enabled', true);
    set('atomic.ai.ollama-url', 'http://localhost:11434');
    set('atomic.ai.defaultChatModel', {
      id: 'llama3.1:8b',
      provider: 'ollama',
    });
    set('atomic.ai.setupComplete', true);
    set('atomic.sidebar-panels', ['aichats']);
  });
  // The default web-search MCP server is a public host; keep it out of the shot.
  await page.route('https://mcp.exa.ai/mcp', route =>
    route.fulfill({ status: 204 }),
  );
}

/** The column that holds a task's estimate, found the way the app does: from the table's class. */
export async function estimateProperty(page: Page, table: string) {
  await page.waitForFunction(() => !!window.store);

  return page.evaluate(async tableSubject => {
    const store = window.store;
    const tableRes = await store.getResource(tableSubject);
    const classRes = await store.getResource(
      tableRes.get('https://atomicdata.dev/properties/classtype') as string,
    );
    const props =
      (classRes.get('https://atomicdata.dev/properties/recommends') as
        | string[]
        | undefined) ?? [];

    return props.find(p => p.startsWith('atomic:prop:'))!;
  }, table);
}

/** Replace the source of the app that is open, the way the apps e2e does. */
export async function setAppSource(page: Page, source: string) {
  await page.evaluate(async next => {
    const store = window.store;
    const subject = decodeURIComponent(
      new URL(location.href).searchParams.get('subject')!,
    );
    const app = await store.getResource(subject);

    for (const value of Object.values(app.getPropVals())) {
      if (typeof value !== 'string' || !value.includes(':')) continue;

      const child = await store.getResource(value).catch(() => undefined);

      if (!child) continue;

      const sourceProp = Object.entries(child.getPropVals()).find(
        ([, v]) =>
          typeof v === 'string' && v.includes('export async function view'),
      )?.[0];

      if (!sourceProp) continue;

      await child.set(sourceProp, next);
      await child.save();

      return;
    }

    throw new Error('The app has no source to replace');
  }, source);
}

/** Name the parts an app was created with after the app, as a person does when they rename them. */
export async function renameAppParts(page: Page, from: string, to: string) {
  await page.evaluate(
    async ({ oldName, newName }) => {
      const store = window.store;
      const subject = decodeURIComponent(
        new URL(location.href).searchParams.get('subject')!,
      );
      const app = await store.getResource(subject);
      const name = 'https://atomicdata.dev/properties/name';

      for (const value of Object.values(app.getPropVals())) {
        if (typeof value !== 'string' || !value.includes(':')) continue;

        const child = await store.getResource(value).catch(() => undefined);
        const current = child?.get(name);

        if (!child || typeof current !== 'string') continue;
        if (!current.startsWith(oldName)) continue;

        await child.set(name, current.replace(oldName, newName));
        await child.save();
      }
    },
    { oldName: from, newName: to },
  );
}
