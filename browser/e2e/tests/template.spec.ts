import { expect, test as baseTest, type Page } from './fixtures';
import {
  FRONTEND_URL,
  before,
  contextMenuClick,
  editTitle,
  makeDrivePublic,
  nodeReachableServerUrl,
  openNewResourcePage,
  openSubject,
  waitForSynced,
} from './test-utils';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { OwnedProcess } from '../scripts/owned-process.mjs';
import { positiveInteger } from '../scripts/concurrency.mjs';

const test = baseTest.extend<{
  site: { directory: string; processes: OwnedProcess[] };
}>({
  // Playwright requires destructuring even for a fixture with no dependencies.
  // eslint-disable-next-line no-empty-pattern
  site: async ({}, use, testInfo) => {
    const directory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'atomic-template-'),
    );
    const processes: OwnedProcess[] = [];

    try {
      await use({ directory, processes });
    } finally {
      await Promise.all(processes.map(process => process.stop()));

      for (const [index, process] of processes.entries()) {
        await testInfo.attach(`template-process-${index}`, {
          body: process.output,
          contentType: 'text/plain',
        });
      }

      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  },
});
const TEMPLATE_IMPORT_TIMEOUT = 60_000;
const WEBSITE_LOCAL_ID = '01j5zrevq917dp0wm4p2vnd7nr';
const ABOUT_LOCAL_ID = '01j67112t57y1nefp8gerjz4ba';
const HOMEPAGE_PROP_LOCAL_ID = 'website/property/homepage';
const FORK_TITLE = 'DRAFT ABOUT LEAK';

async function subjectByLocalId(
  page: Page,
  drive: string,
  localId: string,
): Promise<string> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const subject = await page.evaluate(
      async ({ drive, localId }) => {
        const store = window.store;
        const server = store.getServerUrl().replace(/\/$/, '');
        const url = new URL(`${server}/query`);
        url.searchParams.set(
          'property',
          'https://atomicdata.dev/properties/localId',
        );
        url.searchParams.set('value', localId);
        url.searchParams.set('drive', drive);
        url.searchParams.set('page_size', '5');
        url.searchParams.set(
          'filters',
          JSON.stringify([
            {
              property: 'https://atomicdata.dev/properties/drive',
              value: drive,
            },
          ]),
        );

        const resource = await store.fetchResourceFromServer(url.toString());

        if (resource.error) {
          return null;
        }

        const members = resource.get(
          'https://atomicdata.dev/properties/collection/members',
        );

        if (!Array.isArray(members) || members.length === 0) {
          return null;
        }

        return String(members[0]);
      },
      { drive, localId },
    );

    if (subject) {
      return subject;
    }

    await page.waitForTimeout(400);
  }

  throw new Error(`No resource with localId ${localId} in ${drive}`);
}

/** Fork the About page and rename the fork so a leak is obvious on the public site. */
async function forkAboutPage(page: Page, drive: string) {
  const about = await subjectByLocalId(page, drive, ABOUT_LOCAL_ID);
  await openSubject(page, about);
  await contextMenuClick('editAsFork', page);
  await expect(page.getByText('Fork of')).toBeVisible();
  await editTitle(FORK_TITLE, page);
}

/** `/` should serve About, not the page that happens to have path `/`. */
async function pointHomepageAtAbout(page: Page, drive: string) {
  const websiteSubject = await subjectByLocalId(page, drive, WEBSITE_LOCAL_ID);
  const aboutSubject = await subjectByLocalId(page, drive, ABOUT_LOCAL_ID);
  const homepageProp = await subjectByLocalId(
    page,
    drive,
    HOMEPAGE_PROP_LOCAL_ID,
  );

  const saved = await page.evaluate(
    async ({ websiteSubject, aboutSubject, homepageProp }) => {
      const website = await window.store.getResource(websiteSubject);
      await website.set(homepageProp, aboutSubject);
      await website.save();

      return website.get(homepageProp) === aboutSubject;
    },
    { websiteSubject, aboutSubject, homepageProp },
  );

  expect(saved, 'homepage property should point at About').toBe(true);
}

/**
 * The atomic-server the *app* talks to.
 *
 * `SERVER_URL` only configures the test helpers — the data-browser resolves its
 * own server independently (`VITE_ATOMIC_SERVER_URL` in `.env.development`, or
 * a stored/`?server=` override), and the two are not the same port on every
 * machine: a local managed node runs on 9885 while the standalone dev server
 * runs on 9883. This test applies the template *through the app*, so the
 * scaffolder has to query whichever server the app actually wrote it to.
 * Reading it back from the running Store is the only source that can't drift.
 */
async function appServerUrl(page: Page): Promise<string> {
  const url = await page.evaluate(() => window.store.getServerUrl());

  expect(url, 'The app did not expose a server URL').toBeTruthy();

  return url.replace(/\/$/, '');
}

async function applyWebsiteTemplate(page: Page) {
  const dialog = page.locator('dialog[open][data-top-level="true"]');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Apply template' }).click();
  await expect(dialog).toBeHidden({ timeout: TEMPLATE_IMPORT_TIMEOUT });
  await expect(
    page
      .getByRole('main')
      .getByRole('heading', { name: 'website', level: 1, exact: true }),
  ).toBeVisible({ timeout: TEMPLATE_IMPORT_TIMEOUT });
  await expect
    .poll(
      async () => (await page.locator('.react-flow').boundingBox())?.width ?? 0,
      { timeout: TEMPLATE_IMPORT_TIMEOUT },
    )
    .toBeGreaterThan(100);
}

const pathToPackage = (
  libName: 'lib' | 'cli' | 'react' | 'svelte' | 'create-template',
) => {
  return path.join(__dirname, '..', '..', libName);
};

/**
 * The scaffolder is run straight off its bin rather than through
 * `pnpm link` + `pnpm exec`.
 *
 * `pnpm link` writes a `pnpm-workspace.yaml` into the directory it runs in,
 * which makes EXEC_DIR a workspace *root*. The generated site is not a member
 * of that workspace, so its own `pnpm install` resolves against the root
 * instead, reports "Already up to date", and creates no `node_modules` at all
 * — the site then fails much later with `ad-generate: command not found`,
 * naming nothing that points back here.
 */
const CREATE_TEMPLATE_BIN = path.join(
  pathToPackage('create-template'),
  'bin',
  'src',
  'index.js',
);

async function runCommand(
  site: { directory: string; processes: OwnedProcess[] },
  command: string,
  args: string[],
  subdirectory = '',
) {
  await test.step(`Template ${command === process.execPath ? 'scaffold' : args[0]}`, async () => {
    const buildWorkers = process.env.ATOMIC_TEMPLATE_BUILD_WORKERS
      ? positiveInteger(
          process.env.ATOMIC_TEMPLATE_BUILD_WORKERS,
          'ATOMIC_TEMPLATE_BUILD_WORKERS',
        )
      : Math.max(1, Math.min(2, Math.floor(os.availableParallelism() / 2)));
    const child = new OwnedProcess(command, args, {
      cwd: path.join(site.directory, subdirectory),
      env: {
        ...process.env,
        // Next 16.2's default cpus is CIRCLE_NODE_TOTAL - 1. Budget its
        // build without changing the generated project's config.
        // https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/server/config-shared.ts
        ...(args[0] === 'build'
          ? {
              CIRCLE_NODE_TOTAL: String(buildWorkers + 1),
              RAYON_NUM_THREADS: String(buildWorkers),
            }
          : {}),
      },
    });
    site.processes.push(child);
    const code = await child.done;
    if (code !== 0)
      throw new Error(
        `${command} ${args.join(' ')} exited ${code}:\n${child.output}`,
      );
  });
}

/** The `@tomic/*` packages a generated site depends on, and where they live here. */
const WORKSPACE_PACKAGES = {
  '@tomic/lib': 'lib',
  '@tomic/cli': 'cli',
  '@tomic/react': 'react',
  '@tomic/svelte': 'svelte',
} as const satisfies Record<string, Parameters<typeof pathToPackage>[0]>;

/**
 * Point every `@tomic/*` dependency of the generated site at this checkout.
 *
 * The templates pin the workspace's current version (`^0.41.0-beta.2` today),
 * which by definition is not on npm until it is released — so `pnpm install`
 * fails with ERR_PNPM_NO_MATCHING_VERSION and the test never reaches the site
 * it exists to exercise. `pnpm link` afterwards is too late: install has to
 * resolve the whole manifest first, and so does each `link`.
 *
 * Rewriting the manifest before install means the registry is never asked for
 * these, and the site is built against the code on this branch — which is the
 * point of the test, not an incidental convenience.
 */
async function useWorkspacePackages(directory: string, siteType: string) {
  const manifestPath = path.join(directory, siteType, 'package.json');
  const manifest = JSON.parse(
    await fs.promises.readFile(manifestPath, 'utf-8'),
  ) as Record<string, Record<string, string> | undefined>;

  for (const field of ['dependencies', 'devDependencies']) {
    const deps = manifest[field];

    if (!deps) {
      continue;
    }

    for (const [name, dir] of Object.entries(WORKSPACE_PACKAGES)) {
      if (deps[name]) {
        deps[name] = `link:${pathToPackage(dir)}`;
      }
    }
  }

  await fs.promises.writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function setupTemplateSite(
  site: { directory: string; processes: OwnedProcess[] },
  serverUrl: string,
  drive: string,
  siteType: string,
) {
  const reachable = nodeReachableServerUrl(serverUrl);
  await runCommand(site, process.execPath, [
    CREATE_TEMPLATE_BIN,
    siteType,
    '--template',
    siteType,
    '--server-url',
    reachable,
    '--drive',
    drive,
    '--cms-url',
    FRONTEND_URL,
  ]);
  await useWorkspacePackages(site.directory, siteType);
  await runCommand(
    site,
    'pnpm',
    ['install', '--prefer-offline', '--no-frozen-lockfile', '--ignore-scripts'],
    siteType,
  );
  await runCommand(site, 'pnpm', ['update-ontologies'], siteType);
  await runCommand(site, 'pnpm', ['build'], siteType);
}

function startServer(
  site: { directory: string; processes: OwnedProcess[] },
  siteType: string,
) {
  // Both CLIs pass port 0 to listen(): the OS allocates the actual port while
  // binding, avoiding a reserve/close/rebind race with another test or run.
  const args =
    siteType === 'nextjs-site'
      ? ['exec', 'next', 'start', '--hostname', '127.0.0.1', '--port', '0']
      : [
          'exec',
          'vite',
          'preview',
          '--host',
          '127.0.0.1',
          '--port',
          '0',
          '--strictPort',
        ];
  const child = new OwnedProcess('pnpm', args, {
    cwd: path.join(site.directory, siteType),
    env: { ...process.env, NO_COLOR: '1' },
  });
  site.processes.push(child);

  return child;
}

/**
 * The seeded site is a two-locale site (en default, nl declared): the balloon
 * post has a Dutch translation linked via `translationOf`, everything else is
 * English-only. Asserts the whole document-level i18n contract end-to-end.
 */
async function assertTwoLocaleSite(
  page: Page,
  url: string,
  checkHtmlLang: boolean,
) {
  const ENGLISH_TITLE = 'The Biology of Balloon Animals';
  const DUTCH_TITLE = 'De biologie van ballondieren';
  const SCHEDULED_TITLE = 'Scheduled: Why Time Travel Is Overrated';

  // The nl route of the ENGLISH slug serves the Dutch sibling.
  await page.goto(`${url}/nl/blog/the-biology-of-balloon-animals`);
  await expect(page.locator('body')).toContainText(DUTCH_TITLE);

  if (checkHtmlLang) {
    await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
  }

  // The Dutch slug serves the Dutch post directly, no prefix needed.
  await page.goto(`${url}/blog/de-biologie-van-ballondieren`);
  await expect(page.locator('body')).toContainText(DUTCH_TITLE);

  // The nl listing shows the nl variant, falls back to the canonical for
  // untranslated posts, and never shows both variants of one post.
  await page.goto(`${url}/nl/blog`);
  await expect(page.locator('body')).toContainText(DUTCH_TITLE);
  await expect(page.locator('body')).toContainText('Coffee');
  await expect(page.locator('body')).not.toContainText(ENGLISH_TITLE);
  await expect(page.locator('body')).not.toContainText(SCHEDULED_TITLE);

  // The default-language listing is unchanged, and a future-dated post is hidden.
  await page.goto(`${url}/blog`);
  await expect(page.locator('body')).toContainText(ENGLISH_TITLE);
  await expect(page.locator('body')).not.toContainText(DUTCH_TITLE);
  await expect(page.locator('body')).not.toContainText(SCHEDULED_TITLE);

  // Direct URL to a scheduled post is a 404, not a leak of unpublished content.
  const scheduled = await page.goto(
    `${url}/blog/scheduled-why-time-travel-is-overrated`,
  );
  expect(scheduled?.status()).toBe(404);

  // The English post advertises its Dutch sibling.
  await page.goto(`${url}/blog/the-biology-of-balloon-animals`);
  await expect(
    page.locator('link[rel="alternate"][hreflang="nl"]'),
  ).toHaveCount(1);

  // Nav on a prefixed route keeps the language prefix.
  await page.goto(`${url}/nl/blog`);
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL(/\/nl\/?$/);
}

async function assertHomepageIsAbout(page: Page, url: string) {
  const response = await page.goto(url);
  expect(response?.status()).toBe(200);
  await expect(page.locator('h1')).toContainText('About');
  await expect(page.locator('body')).toContainText('and I love');
  await expect(page.locator('body')).not.toContainText(
    'This is a template site generated with @tomic/template.',
  );
  await expect(page.locator('body')).not.toContainText(FORK_TITLE);

  await page.goto(`${url}/about`);
  await expect(page.locator('h1')).toContainText('About');
  await expect(page.locator('body')).not.toContainText(FORK_TITLE);
}

async function assertLocaleBlogCards(page: Page, url: string) {
  await page.goto(`${url}/nl/blog`);
  await page.getByRole('link', { name: /Coffee/i }).click();
  await expect(page).toHaveURL(
    /\/nl\/blog\/can-you-really-survive-on-coffee-alone/,
  );
}

async function assertCmsFeeds(page: Page, url: string) {
  const sitemap = await page.request.get(`${url}/sitemap.xml`);
  expect(sitemap.status()).toBe(200);
  const sitemapBody = await sitemap.text();
  expect(sitemapBody).toContain('/blog/the-biology-of-balloon-animals');
  expect(sitemapBody).toContain('/nl/blog');
  expect(sitemapBody).not.toContain('scheduled-why-time-travel');
  expect(sitemapBody).not.toContain('Time Travel');
  expect(sitemapBody).not.toContain('DRAFT ABOUT LEAK');

  const rss = await page.request.get(`${url}/rss.xml`);
  expect(rss.status()).toBe(200);
  const rssBody = await rss.text();
  expect(rssBody).toContain('Balloon');
  expect(rssBody).not.toContain('Time Travel');
  expect(rssBody).not.toContain('DRAFT ABOUT LEAK');

  const robots = await page.request.get(`${url}/robots.txt`);
  expect(robots.status()).toBe(200);
  const robotsBody = await robots.text();
  expect(robotsBody).toContain('Sitemap:');
  expect(robotsBody).toContain('/sitemap.xml');
}

/**
 * Editors can jump from the published page to the Data Browser edit form.
 * The CMS origin is a public URL; credentials stay in the Data Browser.
 */
async function assertCmsEditFromSite(page: Page, siteOrigin: string) {
  await page.goto(siteOrigin);
  const editLink = page.getByTestId('cms-edit-link');
  await expect(editLink).toBeVisible();

  const href = await editLink.getAttribute('href');
  expect(
    href,
    'Edit this page should point at the Data Browser edit form',
  ).toBeTruthy();
  expect(href).toContain('/app/edit');
  expect(href).toContain('subject=');
  expect(new URL(href!).origin).toBe(new URL(FRONTEND_URL).origin);

  const popupPromise = page.waitForEvent('popup');
  // Dispatch on the page so the browser chrome cannot swallow Control+E.
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'e',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const popup = await popupPromise;
  expect(popup.url()).toContain('/app/edit');
  expect(popup.url()).toContain('subject=');
  expect(new URL(popup.url()).origin).toBe(new URL(FRONTEND_URL).origin);
  await popup.close();
}

test.describe('Test create-template package', () => {
  test.beforeEach(before);

  test('apply next-js template', async ({ page, site }) => {
    test.slow();
    // before() already created a unique identity and drive for this test.
    const drive = await page.evaluate(() => window.store.getDrive()!);
    await makeDrivePublic(page);

    // Apply the template in data browser
    await openNewResourcePage(page);

    await page.getByTestId('template-button').click();

    await applyWebsiteTemplate(page);
    await forkAboutPage(page, drive.driveURL);
    await pointHomepageAtAbout(page, drive.driveURL);

    await waitForSynced(page);
    const serverUrl = await appServerUrl(page);
    // Release the editor's sockets and rendering while compiling the site.
    await page.goto('about:blank');
    await setupTemplateSite(site, serverUrl, drive, 'nextjs-site');

    {
      //start server
      const child = startServer(site, 'nextjs-site');
      const url = await test.step('Template HTTP readiness', () =>
        child.readyURL());

      await assertHomepageIsAbout(page, url);

      await page.goto(`${url}/blog`);

      // Search for a blogpost
      const searchInput = page.getByRole('searchbox');

      await searchInput.fill('balloon');
      await expect(page.locator('body')).toContainText('Balloon');
      await expect(page.locator('body')).not.toContainText('coffee');

      await searchInput.fill('Time Travel');
      await expect(page.locator('body')).not.toContainText(
        'Scheduled: Why Time Travel Is Overrated',
      );

      await assertTwoLocaleSite(page, url, true);
      await assertCmsEditFromSite(page, url);
      await assertLocaleBlogCards(page, url);
      await assertCmsFeeds(page, url);
    }
  });

  test('apply sveltekit template', async ({ page, site }) => {
    test.slow();
    // before() already created a unique identity and drive for this test.
    const drive = await page.evaluate(() => window.store.getDrive()!);
    await makeDrivePublic(page);

    // Apply the template in data browser
    await openNewResourcePage(page);

    const button = page.getByTestId('template-button');
    await button.click();

    await applyWebsiteTemplate(page);
    await forkAboutPage(page, drive.driveURL);
    await pointHomepageAtAbout(page, drive.driveURL);

    await waitForSynced(page);
    const serverUrl = await appServerUrl(page);
    await page.goto('about:blank');
    await setupTemplateSite(site, serverUrl, drive, 'sveltekit-site');

    {
      const child = startServer(site, 'sveltekit-site');
      //start server
      const url = await test.step('Template HTTP readiness', () =>
        child.readyURL());

      await assertHomepageIsAbout(page, url);

      await page.goto(`${url}/blog`);

      // Search for a blogpost
      const searchInput = page.getByRole('searchbox');
      await searchInput.fill('balloon');
      await expect(page.locator('body')).toContainText('Balloon');
      await expect(page.locator('body')).not.toContainText('coffee');

      await searchInput.fill('Time Travel');
      await expect(page.locator('body')).not.toContainText(
        'Scheduled: Why Time Travel Is Overrated',
      );

      await assertTwoLocaleSite(page, url, true);
      await assertCmsEditFromSite(page, url);
      await assertLocaleBlogCards(page, url);
      await assertCmsFeeds(page, url);
    }
  });
});
