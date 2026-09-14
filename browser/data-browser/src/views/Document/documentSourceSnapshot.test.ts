import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Resource, Store } from '@tomic/react';
import { LoroDoc } from 'loro-crdt/nodejs';
import { captureDocumentSourceSnapshot } from './documentSourceSnapshot';

const { readDocumentV2TiptapJson } = vi.hoisted(() => ({
  readDocumentV2TiptapJson: vi.fn(),
}));
const { documentToHtml } = vi.hoisted(() => ({ documentToHtml: vi.fn() }));

vi.mock('@chunks/RTE/readDocumentV2TiptapJson', () => ({
  readDocumentV2TiptapJson,
}));

vi.mock('./documentToHtml', () => ({ documentToHtml }));

type TestResource = Resource & {
  hasLoroDoc: ReturnType<typeof vi.fn>;
  getLoroDoc: ReturnType<typeof vi.fn>;
};

function resource(hasLoroDoc = true, pending = 0): TestResource {
  const hasLoadedLoroDoc = vi.fn(() => hasLoroDoc);
  const getLoroDoc = vi.fn(() => ({ getPendingTxnLength: () => pending }));

  return { hasLoroDoc: hasLoadedLoroDoc, getLoroDoc } as TestResource;
}

describe('document source dialog capture', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps loading distinct from an empty document and does not read yet', () => {
    const result = captureDocumentSourceSnapshot(
      resource(),
      {} as Store,
      true,
      undefined,
    );

    expect(result).toBeUndefined();
    expect(readDocumentV2TiptapJson).not.toHaveBeenCalled();
  });

  it('renders read-only HTML source from the full document extension set', () => {
    readDocumentV2TiptapJson.mockReturnValue({
      ok: true,
      docJson: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Bold', marks: [{ type: 'bold' }] },
            ],
          },
        ],
      },
    });
    documentToHtml.mockReturnValue('<p><strong>Bold</strong></p>');
    const document = resource();

    expect(
      captureDocumentSourceSnapshot(document, {} as Store, false, undefined),
    ).toEqual({
      kind: 'source',
      content: '<p><strong>Bold</strong></p>',
    });
    expect(readDocumentV2TiptapJson).toHaveBeenCalledWith(
      document,
      expect.anything(),
      { detached: true },
    );
    expect(documentToHtml).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
    );
  });

  it('shows a clear empty state when document HTML has no content', () => {
    readDocumentV2TiptapJson.mockReturnValue({
      ok: true,
      docJson: { type: 'doc', content: [] },
    });
    documentToHtml.mockReturnValue('');

    expect(
      captureDocumentSourceSnapshot(resource(), {} as Store, false, undefined),
    ).toEqual({ kind: 'empty' });
  });

  it('shows an error from resource loading before trying to read source', () => {
    const error = new Error('Access denied');

    expect(
      captureDocumentSourceSnapshot(resource(), {} as Store, false, error),
    ).toEqual({ kind: 'error', error });
    expect(readDocumentV2TiptapJson).not.toHaveBeenCalled();
  });

  it('does not initialize a missing Loro document just to inspect source', () => {
    const noLoro = resource(false);

    expect(
      captureDocumentSourceSnapshot(noLoro, {} as Store, false, undefined),
    ).toMatchObject({ kind: 'unavailable' });
    expect(readDocumentV2TiptapJson).not.toHaveBeenCalled();
    expect(noLoro.hasLoroDoc).toHaveBeenCalledOnce();
    expect(noLoro.getLoroDoc).not.toHaveBeenCalled();
  });

  it('does not commit pending local edits or notify subscribers', () => {
    const doc = new LoroDoc();
    doc.getMap('doc').set('nodeName', 'doc');
    doc.commit();
    let notifications = 0;
    const unsubscribe = doc.subscribe(() => {
      notifications += 1;
    });
    doc.getMap('doc').set('unsaved', true);
    const pendingDocument = {
      hasLoroDoc: vi.fn(() => true),
      getLoroDoc: vi.fn(() => doc),
    } as unknown as TestResource;

    expect(doc.getPendingTxnLength()).toBeGreaterThan(0);
    expect(
      captureDocumentSourceSnapshot(
        pendingDocument,
        {} as Store,
        false,
        undefined,
      ),
    ).toMatchObject({ kind: 'unavailable', message: /pending edits/ });
    expect(readDocumentV2TiptapJson).not.toHaveBeenCalled();
    expect(doc.getPendingTxnLength()).toBeGreaterThan(0);
    expect(notifications).toBe(0);
    unsubscribe();
  });

  it('turns a failed read into dialog error content', () => {
    readDocumentV2TiptapJson.mockReturnValue({
      ok: false,
      error: 'Failed to read document content',
    });

    expect(
      captureDocumentSourceSnapshot(resource(), {} as Store, false, undefined),
    ).toMatchObject({
      kind: 'error',
      error: { message: 'Failed to read document content' },
    });
  });
});
