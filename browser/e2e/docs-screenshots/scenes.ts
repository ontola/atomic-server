/**
 * One function per screenshot. Each gets a page that is signed in as Alex
 * Morgan in an empty "Acme team" drive, builds what its shot needs, and ends
 * on {@link shot}. Add a scene here and list it in screenshots.spec.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Browser, type Page } from '@playwright/test';
import {
  acceptInvite,
  createFromCatalog,
  SERVER_URL,
  editableTitle,
  FRONTEND_URL,
  getCurrentSubject,
  newResource,
  sideBarDriveSwitcher,
  spaUrl,
  topBarShareButton,
  waitForSynced,
} from '../tests/test-utils';
import {
  capture,
  createNamed,
  estimateProperty,
  describeDrive,
  open,
  q4Plan,
  rename,
  renameAppParts,
  setAppSource,
  settled,
  shot,
  tasksTable,
} from './setup';
import { startFakeOllama } from './fake-ollama';

const TASKS_QUESTION = ' what is blocked and what is due this week?';

const ANSWER = `Two tasks are blocked, both waiting on legal:

- **Write pricing page copy** (Sarah Klein, due Fri Oct 30)
- **Update terms of service** (Sarah Klein, due Wed Oct 28)

Due this week:

- Wed Oct 28: Book kickoff venue (Tom Visser) and Update terms of service
- Thu Oct 29: Design onboarding flow (Priya Nair)
- Fri Oct 30: Set up analytics dashboard (Marc de Vries) and Write pricing page copy

The kickoff venue is the one to watch: it is still in Todo and due tomorrow.`;

/** A full-page AI chat that references the Tasks table with @ and gets an answer. */
export async function aiChat(page: Page) {
  // A scripted model on Ollama's own port: no key and no network needed.
  const model = await startFakeOllama({
    name: 'llama3.1:8b',
    title: '🚀 Launch check-in',
    reply: messages =>
      messages[messages.length - 1].role === 'tool'
        ? ANSWER
        : {
            tool: 'query',
            args: {
              description: 'Looking for blocked tasks',
              class: 'task',
              where: [{ property: 'status', value: 'blocked' }],
            },
          },
  });

  try {
    await tasksTable(page);
    await newResource('ai-chat', page);
    const input = page.locator('[contenteditable="true"]').last();
    await input.click();
    await page.keyboard.type('@Tasks');
    // Pick the table from the suggestions; they list the rows' class and views too.
    await expect(page.getByText('All tasks', { exact: true })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('main').getByText('Tasks', { exact: true }).first(),
    ).toBeVisible();
    await page.keyboard.type(TASKS_QUESTION);
    await page.getByTitle('Send').click();
    await expect(
      page.getByText('The kickoff venue is the one to watch'),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByRole('heading', { name: 'Launch check-in' }),
    ).toBeVisible({ timeout: 30_000 });
    // Read the saved chat back: the sidebar's sync icon can keep spinning after the answer.
    await waitForSynced(page);
    await page.reload();
    await expect(
      page.getByText('The kickoff venue is the one to watch'),
    ).toBeVisible({ timeout: 30_000 });
    await shot(page, 'ai-chat');
  } finally {
    await model.close();
  }
}

const MINUTE = 60_000;

/** Who says what, and how many minutes before "now" (the moment the scene starts). */
const CONVERSATION = [
  {
    who: 'Alex Morgan',
    ago: 22,
    text: 'Morning all! Quick launch check-in. Where do we stand on the onboarding design?',
  },
  {
    who: 'Priya Nair',
    ago: 19,
    text: 'Almost there. The new flow is on the board, I only need feedback on step 3 before Thursday.',
  },
  {
    who: 'Alex Morgan',
    ago: 17,
    text: "Great, I'll go through it after lunch. And the pricing page?",
  },
  {
    who: 'Sarah Klein',
    ago: 12,
    text: 'Still blocked on legal. They promised the new plan wording by Friday.',
  },
  {
    who: 'Marc de Vries',
    ago: 9,
    text: 'Analytics is nearly ready, so the pricing page can ship the same day legal signs off.',
  },
  {
    who: 'Alex Morgan',
    ago: 6,
    text: 'Fine, Friday stays the target. We also still need a kickoff venue, any ideas?',
  },
  {
    who: 'Priya Nair',
    ago: 3,
    text: 'The Docklands loft worked well last time. Tom has the venue on his list for tomorrow, I will send him the link.',
  },
];

/** Invite link that gives whoever opens it write access to the drive. */
async function driveInvite(page: Page): Promise<string> {
  await topBarShareButton(page).click();
  // Sharing asks first how you appear to others; the name is already Alex's.
  await page
    .getByRole('button', { name: 'Save and continue', exact: true })
    .click();
  await page
    .getByRole('radiogroup', { name: 'Role for people who join with the link' })
    .getByRole('radio', { name: 'Write' })
    .check();
  await page.getByRole('button', { name: 'Copy invite link' }).click();
  const link = await page
    .locator('[data-invite-link]')
    .getAttribute('data-invite-link');
  await page.keyboard.press('Escape');

  return spaUrl(link!);
}

/** A second browser, signed in as someone else who joined through the invite. */
async function joinAs(
  browser: Browser,
  invite: string,
  name: string,
  chat: string,
) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'Europe/Amsterdam',
  });
  const page = await context.newPage();
  await page.goto(invite);
  await acceptInvite(page, name);
  await page.goto(
    `${FRONTEND_URL}/app/show?subject=${encodeURIComponent(chat)}`,
  );
  await expect(page.getByLabel('Chat input')).toBeVisible({ timeout: 30_000 });

  return page;
}

/**
 * A group chat with four people. Each message is sent with the sender's clock
 * set to its scripted time, so the "x minutes ago" labels are the same every
 * run; the clock goes back to real time right after, because the server
 * refuses signed requests from a clock that is minutes off.
 */
export async function groupChat(page: Page, browser: Browser, drive: string) {
  await tasksTable(page);
  await newResource('chatroom', page);
  await editableTitle(page).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('General');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
  const chat = await getCurrentSubject(page);
  await waitForSynced(page);

  // Invite from the drive's own page so the others can write anywhere in it.
  await page.goto(
    `${FRONTEND_URL}/app/show?subject=${encodeURIComponent(drive)}`,
  );
  const invite = await driveInvite(page);
  await page.goto(
    `${FRONTEND_URL}/app/show?subject=${encodeURIComponent(chat)}`,
  );

  const pages = new Map<string, Page>([['Alex Morgan', page]]);

  for (const name of new Set(CONVERSATION.map(m => m.who)))
    if (!pages.has(name))
      pages.set(name, await joinAs(browser, invite, name, chat));

  const start = Date.now();

  for (const { who, ago, text } of CONVERSATION) {
    const sender = pages.get(who)!;
    const input = sender.getByLabel('Chat input');
    await sender.clock.setSystemTime(start - ago * MINUTE);
    await input.fill(text);
    await input.press('Enter');
    await sender.clock.setSystemTime(Date.now());
    await expect(
      page.locator('[data-entry-key]').filter({ hasText: text }),
    ).toBeVisible({ timeout: 20_000 });
  }

  // Alex's own messages show "now" until the page reads them back from the server.
  await waitForSynced(page);
  await page.reload();
  await expect(page.locator('[data-entry-key]')).toHaveCount(
    CONVERSATION.length,
    { timeout: 20_000 },
  );
  await waitForSynced(page);
  // Freeze Alex's clock at the scene's "now"; nothing is requested after this.
  await page.clock.setFixedTime(start);
  await shot(page, 'chat');
}

/** The drive the overview and drives shots show: a folder with a plan, the Tasks table, a chat and a canvas. */
async function fullDrive(page: Page, drive: string) {
  await describeDrive(
    page,
    drive,
    'Everything the team works on this quarter: plans, tasks and the weekly sync.',
  );
  await q4Plan(page, drive);
  await open(page, drive);
  await tasksTable(page);
  await createNamed(page, drive, 'Chat room', 'team');
  await createNamed(page, drive, 'Canvas', 'Canvas');
  await open(page, drive);
  await expect(page.getByRole('heading', { name: 'Acme team' })).toBeVisible();
  // The activity list is read back from the server, newest first.
  await waitForSynced(page);
  await page.reload();
  await expect(
    page.getByRole('main').getByRole('link', { name: 'Canvas' }).first(),
  ).toBeVisible();
}

/** The drive's own page: what is in it, who touched it last, and the quick-create buttons. */
export async function overview(page: Page, _browser: Browser, drive: string) {
  await fullDrive(page, drive);
  await shot(page, 'overview');
}

/** The drive switcher open on the drive's page. */
export async function drives(page: Page, _browser: Browser, drive: string) {
  await fullDrive(page, drive);
  await settled(page);
  await sideBarDriveSwitcher(page).click();
  await expect(page.getByText('View all drives')).toBeVisible();
  await capture(page, 'drives', { blur: false });
}

/** A document with headings, text and a list. */
export async function documents(page: Page, _browser: Browser, drive: string) {
  const { doc } = await q4Plan(page, drive);
  await open(page, doc);
  await expect(page.getByText('Public launch on 1 December')).toBeVisible();
  await shot(page, 'documents');
}

/** The share dialog of a document: invite link, people with access, public access. */
export async function sharing(page: Page, _browser: Browser, drive: string) {
  const { doc } = await q4Plan(page, drive);
  await open(page, doc);
  await settled(page);
  await topBarShareButton(page).click();
  await page
    .getByRole('button', { name: 'Save and continue', exact: true })
    .click();
  await page
    .getByRole('radiogroup', { name: 'Role for people who join with the link' })
    .getByRole('radio', { name: 'Write' })
    .check();
  await expect(page.getByText('People with access')).toBeVisible();
  await capture(page, 'sharing');
}

/** Something in the sidebar, for shots of a page that would otherwise sit in an empty drive. */
async function sidebarFiller(page: Page, drive: string) {
  await createNamed(page, drive, 'Folder', 'Projects');
  await open(page, drive);
  await tasksTable(page);
  await open(page, drive);
}

/** The Tasks table as a grid: sorted by due date, with the per-status totals below. */
export async function tables(page: Page) {
  await tasksTable(page);
  await page.getByRole('tab', { name: 'All tasks' }).click();
  await expect(page.getByText('Design onboarding flow')).toBeVisible();
  await shot(page, 'tables');
}

/** The same table as a board, one column per status. */
export async function kanban(page: Page) {
  await tasksTable(page);
  await page.getByRole('tab', { name: 'Board' }).click();
  await expect(page.getByText('Design onboarding flow')).toBeVisible();
  await shot(page, 'kanban');
}

/** A meeting in its agenda phase, before it starts. */
export async function meetings(page: Page, _browser: Browser, drive: string) {
  await sidebarFiller(page, drive);
  await createNamed(page, drive, 'Meeting', 'Weekly sync');
  const editor = page.getByLabel('Rich Text Editor');
  await editor.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('# Agenda\n1. ');
  await page.keyboard.type(
    'Review last week: onboarding flow\nPricing page update\nKickoff venue and budget\nBlockers and open questions\n\n',
  );
  await page.keyboard.type(
    '# Notes\nWrite notes here while you talk. They stay as the minutes.',
  );
  await waitForSynced(page);
  await shot(page, 'meetings');
}

/** A canvas with a few pen strokes in two colours and a line of text. */
export async function canvas(page: Page, _browser: Browser, drive: string) {
  await sidebarFiller(page, drive);
  await createNamed(page, drive, 'Canvas', 'Canvas');
  const area = page.locator('canvas').first();
  await expect(area).toBeVisible();
  const box = (await area.boundingBox())!;

  const stroke = async (points: [number, number][]) => {
    const at = ([x, y]: [number, number]) => [box.x + x, box.y + y] as const;
    await page.mouse.move(...at(points[0]));
    await page.mouse.down();

    for (const p of points.slice(1))
      await page.mouse.move(...at(p), { steps: 8 });

    await page.mouse.up();
  };

  const round = (cx: number, cy: number, rx: number, ry: number) =>
    Array.from({ length: 25 }, (_, i): [number, number] => [
      cx + rx * Math.cos((i / 24) * 2 * Math.PI),
      cy + ry * Math.sin((i / 24) * 2 * Math.PI),
    ]);
  const wave = Array.from({ length: 21 }, (_, i): [number, number] => [
    620 + i * 14,
    560 + 24 * Math.sin((i / 20) * 4 * Math.PI),
  ]);

  // The house.
  await stroke([
    [180, 540],
    [180, 400],
    [280, 320],
    [380, 400],
    [380, 540],
    [200, 540],
  ]);
  await stroke([
    [250, 540],
    [250, 470],
    [310, 470],
    [310, 540],
  ]);
  // The sun, and an arrow pointing at the house.
  await stroke(round(700, 280, 55, 55));
  await stroke([
    [440, 400],
    [560, 420],
    [700, 440],
    [760, 400],
  ]);
  await stroke([
    [720, 370],
    [760, 400],
    [725, 435],
  ]);
  await stroke(wave);
  // A red halo and a red spark: tap the colour button, which swaps to the previous colour.
  await page.getByRole('button', { name: 'Pen color' }).click();
  await stroke(round(260, 240, 55, 20));
  await stroke([
    [150, 290],
    [110, 330],
    [150, 360],
    [110, 400],
  ]);
  await page.getByRole('button', { name: 'Pen color' }).click();
  await page.getByRole('button', { name: 'Text tool' }).click();
  await page.mouse.click(box.x + 560, box.y + 120);
  await page.getByLabel('Canvas text').fill('Our new home');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Pen tool' }).click();
  // Fit everything in view.
  await page.getByLabel('Zoom level').click();
  await waitForSynced(page);
  await page.reload();
  await expect(page.getByLabel('Zoom level')).toBeVisible();
  // Keep the pen's cursor preview out of the shot.
  await shot(page, 'canvas', { mouse: [100, 600] });
}

/** The "Team tasks" dashboard app: a page of code that reads the Tasks table and draws it. */
export async function apps(page: Page, _browser: Browser, drive: string) {
  await createNamed(page, drive, 'Folder', 'Projects');
  await open(page, drive);
  const table = await tasksTable(page);
  const estimate = await estimateProperty(page, table);
  await open(page, drive);
  await createFromCatalog(page, 'App');
  const frame = page.frameLocator('iframe[title="App"]');
  await expect(frame.getByRole('heading', { name: 'New app' })).toBeVisible({
    timeout: 60_000,
  });
  await rename(page, 'Team tasks');
  const source = fs
    .readFileSync(path.join(__dirname, 'team-tasks-app.js'), 'utf8')
    .replace('__TASKS__', table)
    .replace('__ESTIMATE__', estimate);
  await setAppSource(page, source);
  await renameAppParts(page, 'New app', 'Team tasks');
  await waitForSynced(page);
  await page.reload();
  await expect(frame.getByRole('heading', { name: 'Team tasks' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(frame.getByText('Due next')).toBeVisible();
  await shot(page, 'apps');
}

/**
 * An event sign-up form, made by asking the AI for it: the scripted model
 * answers with the same create_form call a real one makes, so the form is
 * built by the app's own tool.
 */
async function eventSignup(page: Page, drive: string): Promise<string> {
  const model = await startFakeOllama({
    name: 'llama3.1:8b',
    title: 'Event sign-up form',
    reply: messages =>
      messages[messages.length - 1].role === 'tool'
        ? 'I made the Event sign-up form. Open it to adjust the questions or publish it.'
        : {
            tool: 'create_form',
            args: {
              name: 'Event sign-up',
              rowName: 'Registration',
              pages: [
                {
                  name: 'Your details',
                  fields: [
                    { label: 'Welcome to the Acme kickoff', type: 'heading' },
                    {
                      label:
                        'Tell us who is coming so we can plan the food and the room.',
                      type: 'paragraph',
                    },
                    {
                      label: 'Full name',
                      type: 'short-text',
                      required: true,
                      options: { placeholder: 'Alex Morgan' },
                    },
                    {
                      label: 'Email',
                      type: 'email',
                      required: true,
                      options: { placeholder: 'you@example.com' },
                    },
                    {
                      label: 'Dietary preference',
                      type: 'radio',
                      required: true,
                      choices: [
                        'No preference',
                        'Vegetarian',
                        'Vegan',
                        'Gluten-free',
                      ],
                    },
                    { label: 'I will bring a guest', type: 'checkbox' },
                  ],
                },
              ],
            },
          },
  });

  try {
    await sidebarFiller(page, drive);
    await newResource('ai-chat', page);
    const input = page.locator('[contenteditable="true"]').last();
    await input.click();
    await page.keyboard.type('Make a sign-up form for the Acme kickoff event');
    await page.getByTitle('Send').click();
    await expect(page.getByText('I made the Event sign-up form')).toBeVisible({
      timeout: 60_000,
    });
  } finally {
    await model.close();
  }

  await waitForSynced(page);
  // The AI chats panel is only there for the chat above; the shot is about the form.
  await page.addInitScript(() =>
    localStorage.setItem('atomic.sidebar-panels', '[]'),
  );
  await open(page, drive);
  await page
    .getByRole('navigation')
    .last()
    .getByRole('button', { name: 'Event sign-up', exact: true })
    .click();
  await expect(page.getByRole('tab', { name: 'Fields' })).toBeVisible({
    timeout: 30_000,
  });

  return getCurrentSubject(page);
}

/** The form builder, with a question selected so its settings show on the right. */
export async function forms(page: Page, _browser: Browser, drive: string) {
  await eventSignup(page, drive);
  await page.getByTestId('field-row-radio').click();
  await expect(page.getByTestId('field-label-input')).toHaveValue(
    'Dietary preference',
  );
  await waitForSynced(page);
  await shot(page, 'forms');
}

/** The published form as a visitor sees it, filled in, with the captcha solved. */
export async function formsFill(page: Page, browser: Browser, drive: string) {
  const form = await eventSignup(page, drive);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unpublish' })).toBeVisible();
  await waitForSynced(page);

  const visitor = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    locale: 'en-US',
  });
  const view = await visitor.newPage();

  try {
    // The server may be a beat behind the publish.
    await expect(async () => {
      await view.goto(`${SERVER_URL}/form/${form}`);
      await expect(view.getByLabel('Full name')).toBeVisible({
        timeout: 5_000,
      });
    }).toPass({ timeout: 60_000, intervals: [1000, 2000, 3000] });
    await view.getByLabel('Full name').fill('Marc de Vries');
    await view.getByLabel('Email').fill('marc@acme.example');
    await view.getByLabel('Vegan').check();
    await expect(view.getByText('Verified')).toBeVisible({ timeout: 60_000 });
    await view.mouse.move(1430, 890);
    await view.waitForTimeout(800);
    await capture(view, 'forms-fill');
  } finally {
    await visitor.close();
  }
}
