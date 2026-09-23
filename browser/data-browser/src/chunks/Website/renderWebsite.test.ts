import { describe, expect, it, vi } from 'vitest';
import { core, dataBrowser, type Store, type Resource } from '@tomic/lib';
import {
  starterWebsite,
  websiteConfigSchema,
  assertPrivateWebsiteParent,
  saveWebsiteResource,
} from './websiteModel';
import { renderDocument, renderRows, renderWebsitePage } from './renderWebsite';
import {
  artifactDigest,
  saveAppRelease,
  selectedSubjects,
} from './websiteExport';

describe('website publication output', () => {
  it('renders semantic rich text and escapes source text', () => {
    const html = renderDocument({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Our work' }],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: '<script>alert(1)</script>',
              marks: [{ type: 'bold' }],
            },
          ],
        },
      ],
    });
    expect(html).toContain('<h2>Our work</h2>');
    expect(html).toContain('<strong>&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
  it('fails closed for embedded resources and private media', () => {
    expect(() =>
      renderDocument({ type: 'resource', attrs: { subject: 'private' } }),
    ).toThrow('Cannot export');
    expect(() =>
      renderDocument({
        type: 'image',
        attrs: { src: 'https://private.example/image' },
      }),
    ).toThrow('Image export');
    expect(() =>
      renderDocument({
        type: 'text',
        text: 'click',
        marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
      }),
    ).toThrow('Unsupported document link');
  });
  it('rejects unsafe or colliding routes and CSS network/markup escapes', () => {
    const config = starterWebsite();

    for (const path of ['/../', '/About/', '//', '/%2e%2e/']) {
      expect(
        websiteConfigSchema.safeParse({
          ...config,
          pages: [{ ...config.pages[0], path }],
        }).success,
      ).toBe(false);
    }

    expect(
      websiteConfigSchema.safeParse({
        ...config,
        pages: [config.pages[0], config.pages[0]],
      }).success,
    ).toBe(false);

    for (const css of [
      '</style><script>x</script>',
      '@import "https://x";',
      'a{background:url(https://x)}',
      '@im\\port "https://x";',
    ]) {
      expect(websiteConfigSchema.safeParse({ ...config, css }).success).toBe(
        false,
      );
    }
  });
  it('creates portable navigation and an offline page without Atomic runtime', () => {
    const config = starterWebsite('A & B');
    const about = { ...config.pages[0], path: '/about/', title: 'About' };
    config.pages.push(about);
    const html = renderWebsitePage(config, about, '<p>Published content</p>');
    expect(html).toContain('<base href="../">');
    expect(html).toContain('href="about/index.html" aria-current="page"');
    expect(html).toContain('About · A &amp; B');
    expect(html).toContain('Published content');
    expect(html).not.toContain('<script');
    expect(html).toContain("default-src 'none'");
  });
  it('renders selected fields in a grid without executing their contents', () => {
    const html = renderRows(
      {
        table: 'table',
        title: 'People',
        layout: 'grid',
        rows: ['one'],
        columns: [{ property: 'name', label: 'Name' }],
      },
      [['<img onerror=alert(1)>']],
    );
    expect(html).toContain('class="cards"');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
  });
  it('hashes file contents independent of insertion order; changed content is a new release', async () => {
    expect(await artifactDigest({ 'a.html': 'a', 'b.html': 'b' })).toBe(
      await artifactDigest({ 'b.html': 'b', 'a.html': 'a' }),
    );
    expect(await artifactDigest({ 'a.html': 'a' })).not.toBe(
      await artifactDigest({ 'a.html': 'draft' }),
    );
  });
  it('selects only named table rows for a public view snapshot', () => {
    const config = starterWebsite('People');
    config.pages[0].tables = [
      {
        table: 'table',
        title: 'People',
        layout: 'table',
        rows: ['chosen-row'],
        columns: [{ property: 'name', label: 'Name' }],
      },
    ];
    expect(selectedSubjects(config)).toEqual(['table', 'chosen-row']);
  });
});

describe('private website authoring', () => {
  it('refuses to publish a non-App through the shared release path', async () => {
    const resource = {
      subject: 'project',
      get: () => undefined,
      canWrite: async () => true,
      hasClasses: (klass: string) => klass !== dataBrowser.classes.view,
    } as unknown as Resource;
    const store = {
      getResource: async () => resource,
      getAgent: () => ({ subject: 'owner' }),
    } as unknown as Store;
    const config = starterWebsite();
    const files = { 'index.html': '<p>private</p>' };
    await expect(
      saveAppRelease(store, resource, {
        version: 1,
        renderer: 'atomic-static-v1',
        project: resource.subject,
        config,
        files,
        digest: await artifactDigest(files),
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toThrow('Only an App');
  });
  it('rejects inherited public access and unresolved or cyclic ancestry', async () => {
    const resources: Record<string, Record<string, unknown>> = {
      site: { [core.properties.parent]: 'drive' },
      drive: {
        [core.properties.read]: ['https://atomicdata.dev/agents/publicAgent'],
      },
    };
    const store = {
      getResource: vi.fn(async (id: string) => ({
        error: !resources[id],
        get: (property: string) => resources[id]?.[property],
      })),
    } as unknown as Store;
    await expect(assertPrivateWebsiteParent(store, 'site')).rejects.toThrow(
      'private drive',
    );
    resources.drive = { [core.properties.parent]: 'site' };
    await expect(assertPrivateWebsiteParent(store, 'site')).rejects.toThrow(
      'ancestry',
    );
    await expect(assertPrivateWebsiteParent(store, 'missing')).rejects.toThrow(
      'permissions',
    );
    resources.drive = {};
    await expect(
      assertPrivateWebsiteParent(store, 'site'),
    ).resolves.toBeUndefined();
  });
  it('does not report a queued local save as durable', async () => {
    const resource = {
      subject: 'test-site',
      save: vi.fn().mockResolvedValue('offline'),
    } as unknown as Resource;
    await expect(saveWebsiteResource(resource)).rejects.toThrow(
      'pending locally',
    );
  });
});

it('rejects layout references outside the explicit selection and duplicate sections', () => {
  const config = starterWebsite();
  const section = {
    kind: 'table',
    index: 0,
    span: 'half',
    className: 'feature',
  };
  expect(
    websiteConfigSchema.safeParse({
      ...config,
      pages: [{ ...config.pages[0], sections: [section] }],
    }).success,
  ).toBe(false);
  const intro = { ...section, kind: 'intro' };
  expect(
    websiteConfigSchema.safeParse({
      ...config,
      pages: [{ ...config.pages[0], sections: [intro, intro] }],
    }).success,
  ).toBe(false);
});
