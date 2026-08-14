import { describe, it } from 'vitest';
import { core, server } from './index.js';
import { forks } from './ontologies/forks.js';
import {
  cmsEditUrl,
  cmsSitemapPaths,
  escapeXml,
  isListedCmsResource,
  renderRobotsTxt,
  renderRssXml,
  renderSitemapXml,
} from './cms.js';
import { forkResource } from './forks.js';
import { testStore } from './test-store.js';

const BLOGPOST = 'https://example.com/class/blogpost';
const PAGE = 'https://example.com/class/page';
const PUBLISHED_AT = 'https://example.com/property/published-at';
const NOW = 1_700_000_000_000;

const listing = {
  blogpostClass: BLOGPOST,
  publishedAtProperty: PUBLISHED_AT,
  now: NOW,
};

describe('cms listing', () => {
  it('builds the Data Browser edit form URL', ({ expect }) => {
    expect(cmsEditUrl('http://localhost:9883', 'did:ad:abc')).toBe(
      'http://localhost:9883/app/edit?subject=did%3Aad%3Aabc',
    );
    expect(cmsEditUrl('http://localhost:9883/', 'did:ad:abc')).toBe(
      'http://localhost:9883/app/edit?subject=did%3Aad%3Aabc',
    );
  });

  it('lists a published blog post and hides future or undated ones', async ({
    expect,
  }) => {
    const { store } = await testStore();
    const drive = await store.newResource({
      isA: server.classes.drive,
      noParent: true,
    });
    await drive.save();

    const published = await store.newResource({
      parent: drive.subject,
      isA: BLOGPOST,
      propVals: {
        [core.properties.name]: 'Out now',
        [PUBLISHED_AT]: NOW - 1,
      },
    });
    const scheduled = await store.newResource({
      parent: drive.subject,
      isA: BLOGPOST,
      propVals: {
        [core.properties.name]: 'Later',
        [PUBLISHED_AT]: NOW + 1,
      },
    });
    const draft = await store.newResource({
      parent: drive.subject,
      isA: BLOGPOST,
      propVals: {
        [core.properties.name]: 'No date',
      },
    });
    const page = await store.newResource({
      parent: drive.subject,
      isA: PAGE,
      propVals: {
        [core.properties.name]: 'About',
      },
    });

    expect(isListedCmsResource(published, listing)).toBe(true);
    expect(isListedCmsResource(scheduled, listing)).toBe(false);
    expect(isListedCmsResource(draft, listing)).toBe(false);
    expect(isListedCmsResource(page, listing)).toBe(true);
  });

  it('hides a fork even when it copies a published href', async ({
    expect,
  }) => {
    const { store } = await testStore();
    const drive = await store.newResource({
      isA: server.classes.drive,
      noParent: true,
    });
    await drive.save();

    const original = await store.newResource({
      parent: drive.subject,
      isA: PAGE,
      propVals: {
        [core.properties.name]: 'About',
        [core.properties.description]: 'Public page',
      },
    });
    await original.save();

    const fork = await forkResource(store, original, drive.subject);

    expect(isListedCmsResource(original, listing)).toBe(true);
    expect(fork.getClasses()).toContain(forks.classes.fork);
    expect(isListedCmsResource(fork, listing)).toBe(false);
  });
});

describe('cms feeds', () => {
  it('emits each href once per language, default unprefixed', ({ expect }) => {
    expect(
      cmsSitemapPaths(['/', '/blog', '/blog/later'], ['en', 'nl'], 'en'),
    ).toEqual([
      '/',
      '/blog',
      '/blog/later',
      '/nl',
      '/nl/blog',
      '/nl/blog/later',
    ]);
  });

  it('renders sitemap, robots, and RSS without leaking unpublished paths', ({
    expect,
  }) => {
    const listed = cmsSitemapPaths(['/', '/blog/out-now'], ['en', 'nl'], 'en');
    const sitemap = renderSitemapXml('http://localhost:3000', listed);

    expect(sitemap).toContain('http://localhost:3000/blog/out-now');
    expect(sitemap).toContain('http://localhost:3000/nl/blog/out-now');
    expect(sitemap).not.toContain('scheduled');

    expect(renderRobotsTxt('http://localhost:3000/')).toContain(
      'Sitemap: http://localhost:3000/sitemap.xml',
    );

    const rss = renderRssXml('http://localhost:3000', 'Demo & Co', [
      {
        title: 'Out now',
        path: '/blog/out-now',
        description: 'A <post> & more',
        publishedAt: 1_700_000_000_000,
      },
    ]);

    expect(rss).toContain('<title>Demo &amp; Co</title>');
    expect(rss).toContain('A &lt;post&gt; &amp; more');
    expect(rss).not.toContain('Time Travel');
    expect(escapeXml(`"'`)).toBe('&quot;&apos;');
  });
});
