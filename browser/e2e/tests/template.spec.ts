import { expect, test, type Page } from '@playwright/test';
import { exec } from 'child_process';
import {
  FRONTEND_URL,
  before,
  contextMenuClick,
  editTitle,
  makeDrivePublic,
  newDrive,
  nodeReachableServerUrl,
  openSubject,
  signIn,
  sidebarNewResourceButton,
} from './test-utils';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import kill from 'kill-port';
import { log } from 'node:console';
import os from 'node:os';

const EXEC_DIR = path.join(os.tmpdir(), 'atomic-data-template-tests');
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
  await expect(
    page.getByRole('heading', { name: 'website', level: 1 }),
  ).toBeVisible({ timeout: TEMPLATE_IMPORT_TIMEOUT });
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

const execAsync = async (command: Parameters<typeof exec>[0], cwd?: string) => {
  return new Promise((resolve, reject) => {
    const options = {
      cwd: cwd ? path.join(EXEC_DIR, cwd) : EXEC_DIR,
    };

    exec(command, options, (err, stdout, stderr) => {
      // eslint-disable-next-line no-console
      console.log(stdout, stderr);

      if (err) {
        // eslint-disable-next-line no-console
        console.log(
          `Encountered error while excecuting ${command} in ${options.cwd}`,
        );
        reject(new Error(err.message));
      }

      resolve(stdout.toString());
    });
  });
};

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
async function useWorkspacePackages(siteType: string) {
  const manifestPath = path.join(EXEC_DIR, siteType, 'package.json');
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
  serverUrl: string,
  drive: string,
  siteType: string,
) {
  fs.mkdirSync(EXEC_DIR, { recursive: true });

  // `serverUrl` comes from the browser store (`atomic.localhost` in dagger).
  // create-template runs in Node and needs the service-binding hostname.
  const reachable = nodeReachableServerUrl(serverUrl);

  await execAsync(
    `node ${CREATE_TEMPLATE_BIN} ${siteType} --template ${siteType} --server-url ${reachable} --drive ${drive} --cms-url ${FRONTEND_URL}`,
  );

  await useWorkspacePackages(siteType);

  // No frozen lockfile because it would cause issues in the ci. No dependency
  // build scripts either: none of them matter to what this test asserts, and
  // pnpm 11 turns an unapproved one (`sharp`, via next) into a hard
  // ERR_PNPM_IGNORED_BUILDS failure rather than a warning.
  await execAsync(
    'pnpm install --no-frozen-lockfile --ignore-scripts',
    siteType,
  );

  await execAsync('pnpm update-ontologies', siteType);
}

function startServer(siteType: string) {
  // Adjust runtime commands per template
  const command =
    siteType === 'nextjs-site'
      ? 'pnpm build && pnpm start --port 3000'
      : 'pnpm run build && NO_COLOR=1 pnpm preview --port 4174';

  return spawn(command, {
    cwd: path.join(EXEC_DIR, siteType),
    shell: true,
  });
}

const waitForServer = (
  childProcess: ChildProcess,
  timeout = 300000,
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      childProcess.kill(); // Kill the process if it times out
      reject(new Error('Server took too long to start.'));
    }, timeout);

    childProcess.stdout?.on('data', data => {
      const message = data.toString();

      const match = message.match(/http:\/\/localhost:\d+/);

      if (match) {
        clearTimeout(timeoutId); // Clear the timeout when resolved
        resolve(match[0]); // Resolve with the URL
      }
    });

    childProcess.stderr?.on('data', data => console.error(data.toString()));

    childProcess.on('exit', code => {
      clearTimeout(timeoutId); // Clear the timeout when the process exits

      if (code !== 0) {
        reject(new Error(`Server process exited with code ${code}`));
      }
    });
  });
};

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
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(before);

  // A run that is killed (or that fails before `afterAll`) leaves EXEC_DIR
  // behind, and `create-template` then *prompts* "Folder already exists …
  // Continue? (y/n)" on stdin — which `exec` never answers, so the next run
  // hangs until the test times out. Start from a clean slate instead of
  // trusting the previous run's cleanup.
  test.beforeAll(async () => {
    await fs.promises.rm(EXEC_DIR, { recursive: true, force: true });
  });

  test('apply next-js template', async ({ page }) => {
    test.slow();
    test.setTimeout(10 * 60 * 1000);
    await signIn(page);
    const drive = await newDrive(page);
    await makeDrivePublic(page);

    // Apply the template in data browser
    await sidebarNewResourceButton(page).click();
    await expect(page).toHaveURL(/\/app\/new(\?|$)/);

    await page.getByTestId('template-button').click();

    await applyWebsiteTemplate(page);
    await forkAboutPage(page, drive.driveURL);
    await pointHomepageAtAbout(page, drive.driveURL);

    await setupTemplateSite(
      await appServerUrl(page),
      drive.driveURL,
      'nextjs-site',
    );

    try {
      //start server
      const child = startServer('nextjs-site');
      const url = await waitForServer(child);

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
    } finally {
      try {
        await kill(3000);
        log('Next.js server shut down successfully');
        expect(true).toBe(true);
      } catch (err) {
        console.error('Failed to shut down Next.js server:', err);
      }
    }
  });

  test('apply sveltekit template', async ({ page }) => {
    test.slow();
    test.setTimeout(10 * 60 * 1000);
    await signIn(page);
    const drive = await newDrive(page);
    await makeDrivePublic(page);

    // Apply the template in data browser
    await sidebarNewResourceButton(page).click();
    await expect(page).toHaveURL(/\/app\/new(\?|$)/);

    const button = page.getByTestId('template-button');
    await button.click();

    await applyWebsiteTemplate(page);
    await forkAboutPage(page, drive.driveURL);
    await pointHomepageAtAbout(page, drive.driveURL);

    await setupTemplateSite(
      await appServerUrl(page),
      drive.driveURL,
      'sveltekit-site',
    );

    try {
      const child = startServer('sveltekit-site');
      //start server
      const url = await waitForServer(child);

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
    } finally {
      try {
        await kill(4174);
        log('SvelteKit server shut down successfully');
        // We need to wait for the process to be killed and playwright does not wait unless there is another expect coming.
        expect(true).toBe(true);
      } catch (err) {
        console.error('Failed to shut down SvelteKit server:', err);
      }
    }
  });

  test.afterAll(async () => {
    if (!fs.existsSync(EXEC_DIR)) {
      // eslint-disable-next-line no-console
      console.log('No EXEC_DIR to delete, skipping...');

      return;
    }

    try {
      await fs.promises.rm(EXEC_DIR, { recursive: true, force: true });
      // eslint-disable-next-line no-console
      console.log('Cleared EXEC_DIR');
    } catch (error) {
      console.error(`Failed to delete ${EXEC_DIR}:`, error);
    }
  });
});
