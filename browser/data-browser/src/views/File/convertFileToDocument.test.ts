// @wc-ignore-file
import { core, dataBrowser, Resource, server, Store } from '@tomic/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Node's test fetch cannot load the browser WASM URL. The application aliases
// this package to its web build; this focused Loro state test uses its Node WASM.
vi.mock('loro-crdt', () => import('loro-crdt/nodejs'));

// The image picker imports dialog-only UI. The Markdown test needs the same
// collaborative schema shape, but does not need image-picker UI behavior.
vi.mock('@chunks/RTE/ImagePicker', async () => {
  const { Image } = await import('@tiptap/extension-image');

  return { ExtendedImage: Image };
});

vi.mock('@components/forms/FilePicker/FilePickerDialog', () => ({
  FilePickerDialog: () => null,
}));

vi.mock('@components/AtomicLink', () => ({ AtomicLink: 'a' }));

vi.mock('@chunks/RTE/ResourceExtension/ResourceNode', async () => {
  const { Node } = await import('@tiptap/core');

  return {
    ResourceNode: Node.create({
      name: 'atomic-data-resource',
      group: 'block',
      atom: true,
    }),
    ResourceNodeInline: Node.create({
      name: 'atomic-data-resource-inline',
      group: 'inline',
      inline: true,
      atom: true,
    }),
  };
});
import {
  convertFileToDocument,
  ensureDocumentName,
  fileContentsToTiptapJson,
  getConvertibleTextFileKind,
  getUploadedFileName,
  plainTextToTiptapJson,
  replacementClasses,
} from './convertFileToDocument';

describe('getConvertibleTextFileKind', () => {
  it('recognizes Markdown extensions and MIME types after normalizing them', () => {
    expect(getConvertibleTextFileKind('Notes.MARKDOWN', undefined)).toBe(
      'markdown',
    );
    expect(
      getConvertibleTextFileKind('upload', ' Text/Markdown; charset=UTF-8 '),
    ).toBe('markdown');
    expect(getConvertibleTextFileKind('upload', 'text/x-markdown')).toBe(
      'markdown',
    );
  });

  it('recognizes plain text without accepting every text subtype', () => {
    expect(getConvertibleTextFileKind('draft.TXT', undefined)).toBe(
      'plain-text',
    );
    expect(
      getConvertibleTextFileKind('upload', 'TEXT/PLAIN; charset=utf-8'),
    ).toBe('plain-text');
    expect(
      getConvertibleTextFileKind('page.html', 'text/html'),
    ).toBeUndefined();
    expect(
      getConvertibleTextFileKind('script.js', 'text/javascript'),
    ).toBeUndefined();
  });
});

describe('plainTextToTiptapJson', () => {
  it('preserves every line break literally as hard breaks', () => {
    expect(plainTextToTiptapJson('one\r\ntwo\n\nthree\n')).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'one' },
            { type: 'hardBreak' },
            { type: 'text', text: 'two' },
            { type: 'hardBreak' },
            { type: 'hardBreak' },
            { type: 'text', text: 'three' },
            { type: 'hardBreak' },
          ],
        },
      ],
    });
  });

  it('keeps an empty text file as an empty paragraph', () => {
    expect(plainTextToTiptapJson('')).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    });
  });
});

describe('fileContentsToTiptapJson', () => {
  // First call pays for the Node WASM + collaborative schema import; CI
  // regularly misses the default 5s when the suite is already warm-transforming.
  it('uses the collaborative Markdown schema so Markdown formatting becomes document nodes', async () => {
    const json = await fileContentsToTiptapJson(
      '# Heading\n\nThis is **bold**.',
      'markdown',
      new Store(),
    );

    expect(json).toMatchObject({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ text: 'Heading' }],
        },
        {
          type: 'paragraph',
          content: [
            { text: 'This is ' },
            { text: 'bold', marks: [{ type: 'bold' }] },
            { text: '.' },
          ],
        },
      ],
    });
  }, 15_000);

  it('keeps blank Markdown and an unpaired marker as document text', async () => {
    await expect(
      fileContentsToTiptapJson('', 'markdown', new Store()),
    ).resolves.toMatchObject({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    });
    await expect(
      fileContentsToTiptapJson('**', 'markdown', new Store()),
    ).resolves.toMatchObject({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ text: '**' }] }],
    });
  });
});

describe('convertFileToDocument', () => {
  async function uploadedFile() {
    const resource = new Resource('did:ad:uploaded-file');
    resource.loading = false;
    await resource.set(core.properties.name, 'notes.txt', false);
    await resource.set(core.properties.isA, [server.classes.file], false);

    return resource;
  }

  it('checks permissions before fetching and leaves the file class untouched', async () => {
    const resource = await uploadedFile();
    const store = new Store();
    vi.spyOn(store, 'getAgent').mockReturnValue({
      subject: 'did:ad:agent:writer',
    } as ReturnType<Store['getAgent']>);
    vi.spyOn(resource, 'canWrite').mockResolvedValue([false, undefined]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      convertFileToDocument({
        resource,
        store,
        downloadUrl: 'blob:local-upload',
        mimeType: 'text/plain',
      }),
    ).rejects.toThrow('permission');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resource.get(core.properties.isA)).toEqual([server.classes.file]);
  });

  it('does not change a file when its local-first URL cannot be fetched', async () => {
    const resource = await uploadedFile();
    const store = new Store();
    vi.spyOn(store, 'getAgent').mockReturnValue({
      subject: 'did:ad:agent:writer',
    } as ReturnType<Store['getAgent']>);
    vi.spyOn(resource, 'canWrite').mockResolvedValue([true, undefined]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 404 })),
    );

    await expect(
      convertFileToDocument({
        resource,
        store,
        downloadUrl: 'blob:local-upload',
        mimeType: 'text/plain',
      }),
    ).rejects.toThrow('Could not read');
    expect(resource.get(core.properties.isA)).toEqual([server.classes.file]);
  });

  it('keeps extra classes while replacing only the File class', async () => {
    const resource = await uploadedFile();
    await resource.set(
      core.properties.isA,
      [server.classes.file, 'https://example.com/classes/Attachment'],
      false,
    );

    expect(replacementClasses(resource)).toEqual([
      dataBrowser.classes.documentV2,
      'https://example.com/classes/Attachment',
    ]);
  });

  it('uses upload filename for Markdown detection and creates the required document name', async () => {
    const resource = new Resource('did:ad:filename-only-upload');
    resource.loading = false;
    await resource.set(server.properties.filename, 'README.MD', false);
    await resource.set(core.properties.isA, [server.classes.file], false);

    expect(getUploadedFileName(resource)).toBe('README.MD');
    expect(
      getConvertibleTextFileKind(getUploadedFileName(resource), 'text/plain'),
    ).toBe('markdown');

    await ensureDocumentName(resource);

    expect(resource.get(core.properties.name)).toBe('README.MD');
  });
});
