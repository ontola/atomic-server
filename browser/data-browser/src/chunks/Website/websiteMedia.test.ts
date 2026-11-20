import { describe, expect, it, vi } from 'vitest';
import { core, dataBrowser, Datatype, server, type Store } from '@tomic/lib';
import { snapshotWebsiteImage } from './websiteMedia';
import { buildWebsiteArtifact } from './websiteExport';
import { starterWebsite } from './websiteModel';
vi.mock('./optimizeWebsiteImage', () => ({
  optimizeWebsiteImage: async (blob: Blob) => blob,
}));

function fixture() {
  const resources: Record<
    string,
    {
      title?: string;
      hasClasses?: (c: string) => boolean;
      get?: (p: string) => string | undefined;
    }
  > = {
    photo: {
      hasClasses: (c: string) => c === server.classes.file,
      get: (p: string) =>
        ({
          [server.properties.mimetype]: 'image/png',
          'https://atomicdata.dev/properties/blob': `did:ad:blob:${'a'.repeat(64)}`,
        })[p],
    },
    table: { hasClasses: (c: string) => c === dataBrowser.classes.table },
    row: {
      title: 'Bread',
      get: (p: string) =>
        ({
          [core.properties.parent]: 'table',
          photoColumn: 'photo',
          hiddenColumn: 'private',
        })[p],
    },
    photoColumn: {
      get: (p: string) =>
        ({
          [core.properties.datatype]: Datatype.ATOMIC_URL,
          [core.properties.classtype]: server.classes.file,
        })[p],
    },
  };
  const getResource = vi.fn(async (subject: string) => ({
    subject,
    ...resources[subject],
  }));
  const store = {
    getResource,
    getClientDb: () => ({
      getBlob: async () => new Uint8Array([1, 2, 3]),
      blake3Hash: async () => new Uint8Array(32).fill(170),
      putBlob: vi.fn(),
    }),
  } as unknown as Store;

  return { store, getResource, resources };
}

describe('website media snapshots', () => {
  it('packages selected gallery and File cells without exporting other relationships', async () => {
    const { store, getResource } = fixture();
    const config = starterWebsite();
    config.pages[0] = {
      ...config.pages[0],
      documents: [],
      media: [{ subject: 'photo', alt: 'Bread <fresh>' }],
      tables: [
        {
          table: 'table',
          title: 'Products',
          layout: 'grid',
          rows: ['row'],
          columns: [{ property: 'photoColumn', label: 'Photo' }],
        },
      ],
      sections: [
        { kind: 'gallery', index: 0, span: 'full', className: '' },
        { kind: 'table', index: 0, span: 'full', className: '' },
      ],
    };
    const artifact = await buildWebsiteArtifact(store, 'website', config);
    expect(artifact.files['index.html']).toContain(
      `/assets/${'aa'.repeat(32)}.png`,
    );
    expect(artifact.files['index.html']).not.toContain('data:image');
    expect(JSON.stringify(artifact)).not.toContain('AQID');
    expect(artifact.files['index.html'].match(/<img /g)).toHaveLength(2);
    expect(artifact.files['index.html']).toContain('Bread &lt;fresh&gt;');
    expect(getResource).not.toHaveBeenCalledWith('private');
    expect(artifact.files['index.html']).not.toContain('did:ad:blob');
  });
  it('rejects non-image files and oversized media', async () => {
    const { store, resources } = fixture();
    resources.photo.get = () => 'image/svg+xml';
    await expect(snapshotWebsiteImage(store, 'photo')).rejects.toThrow('PNG');
    const second = fixture();
    second.store.getClientDb = () =>
      ({
        getBlob: async () => new Uint8Array(50_000_001),
      }) as unknown as ReturnType<Store['getClientDb']>;
    await expect(snapshotWebsiteImage(second.store, 'photo')).rejects.toThrow(
      '50 MB',
    );
  });
});
