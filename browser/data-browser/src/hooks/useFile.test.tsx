// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Resource, Store, StoreContext, server } from '@tomic/react';
import { useFileInfo } from './useFile';

const downloadUrl = 'https://example.com/download/files/image';

async function fileResource() {
  const resource = new Resource('did:ad:file-preview');
  const values = new Map([
    [server.properties.downloadUrl, downloadUrl],
    [server.properties.mimetype, 'image/png'],
    [server.properties.filesize, 10],
    [
      'https://atomicdata.dev/properties/blob',
      `did:ad:blob:${'ab'.repeat(32)}`,
    ],
  ] as [string, string | number][]);
  vi.spyOn(resource, 'get').mockImplementation(property =>
    values.get(property),
  );

  return resource;
}

function Preview({ resource }: { resource: Resource }) {
  const { downloadUrl: src, loading } = useFileInfo(resource);

  return loading ? <span>Loading</span> : <img src={src} alt='' />;
}

describe('file preview first render', () => {
  it('does not request the server while local blob lookup is pending', async () => {
    const store = new Store({ serverUrl: 'https://example.com' });
    vi.spyOn(store, 'getClientDb').mockReturnValue({
      getBlob: () => new Promise(() => {}),
    } as NonNullable<ReturnType<Store['getClientDb']>>);
    const resource = await fileResource();
    // Effects have not completed on the first render, just as on mount in
    // the browser. A remote src here can trigger a 404 before the blob loads.
    const markup = renderToStaticMarkup(
      <StoreContext value={store}>
        <Preview resource={resource} />
      </StoreContext>,
    );
    expect(markup).not.toContain(downloadUrl);
    expect(markup).toContain('Loading');
  });

  it('uses the server immediately when there is no local database', async () => {
    const store = new Store({ serverUrl: 'https://example.com' });
    const resource = await fileResource();
    const markup = renderToStaticMarkup(
      <StoreContext value={store}>
        <Preview resource={resource} />
      </StoreContext>,
    );
    expect(markup).toContain(downloadUrl);
  });
});
