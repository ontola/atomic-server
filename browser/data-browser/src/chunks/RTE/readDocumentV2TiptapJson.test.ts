import { describe, expect, it, vi } from 'vitest';
import type { Resource, Store } from '@tomic/react';
import { LoroDoc, LoroList, LoroMap, LoroText } from 'loro-crdt/nodejs';
import { readDocumentV2TiptapJson } from './readDocumentV2TiptapJson';

// Keep this conversion test focused on Loro → TipTap. The application React
// barrel also exports UI components, which is unnecessary (and unavailable)
// in Vitest's Node environment.
vi.mock('@tomic/react', () => ({
  dataBrowser: { classes: { documentV2: 'document-v2' } },
}));

// Vite aliases the browser app's `loro-crdt` import to its WebAssembly build.
// In this Node-only test, make both the converter and fixtures use Loro's
// native Node build so their container `instanceof` checks share one runtime.
vi.mock('loro-crdt', () => import('loro-crdt/nodejs'));

vi.mock('./getCollaborativeEditorSchema', async () => {
  const [{ getSchema }, { StarterKit }] = await Promise.all([
    import('@tiptap/core'),
    import('@tiptap/starter-kit'),
  ]);

  return {
    getCollaborativeEditorSchema: () => ({ schema: getSchema([StarterKit]) }),
  };
});

function resourceFor(doc: LoroDoc, hasLoroDoc = true): Resource {
  return {
    hasClasses: (classSubject: string) => classSubject === 'document-v2',
    hasLoroDoc: () => hasLoroDoc,
    getLoroDoc: () => doc,
  } as unknown as Resource;
}

function richTextDoc(): LoroDoc {
  const doc = new LoroDoc();
  const root = doc.getMap('doc');
  root.set('nodeName', 'doc');
  const rootChildren = root.getOrCreateContainer('children', new LoroList());
  const paragraph = rootChildren.pushContainer(new LoroMap()).getAttached()!;
  paragraph.set('nodeName', 'paragraph');
  const paragraphChildren = paragraph.getOrCreateContainer(
    'children',
    new LoroList(),
  );
  const text = paragraphChildren.pushContainer(new LoroText()).getAttached()!;
  text.applyDelta([
    { insert: 'Bold', attributes: { bold: {} } },
    { insert: ' and plain' },
  ]);
  doc.commit();

  return doc;
}

describe('readDocumentV2TiptapJson', () => {
  it('reads rich Loro content, including marks, without changing the document', () => {
    const doc = richTextDoc();
    const before = doc.getMap('doc').toJSON();
    const versionBefore = doc.oplogVersion().toJSON();

    const result = readDocumentV2TiptapJson(resourceFor(doc), {} as Store, {
      detached: true,
    });

    expect(result).toEqual({
      ok: true,
      docJson: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', marks: [{ type: 'bold' }], text: 'Bold' },
              { type: 'text', text: ' and plain' },
            ],
          },
        ],
      },
    });
    expect(doc.getMap('doc').toJSON()).toEqual(before);
    expect(doc.oplogVersion().toJSON()).toEqual(versionBefore);
    expect(doc.getPendingTxnLength()).toBe(0);
  });

  it('reports an initialized document without a body as an empty document', () => {
    const doc = new LoroDoc();
    doc.commit();

    expect(readDocumentV2TiptapJson(resourceFor(doc), {} as Store)).toEqual({
      ok: true,
      docJson: { type: 'doc', content: [] },
    });
  });

  it('reports malformed Loro body data as a failure', () => {
    const doc = new LoroDoc();
    doc.getMap('doc').set('nodeName', 'not-a-tiptap-node');
    doc.commit();

    expect(readDocumentV2TiptapJson(resourceFor(doc), {} as Store)).toEqual({
      ok: false,
      error: 'Failed to read document content',
    });
  });
});
