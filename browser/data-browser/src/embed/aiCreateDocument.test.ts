// @vitest-environment jsdom
// @wc-ignore-file
import { expect, it, vi } from 'vitest';
import '../components/CustomViewProvider';
import {
  core,
  createResourceFromCompact,
  dataBrowser,
  expandSubject,
  server,
  shortenSubject,
  type NativeChannel,
} from '@tomic/react';
import { hasDocumentContent } from '@chunks/RTE/readDocumentV2TiptapJson';
import { runDocumentEdit } from '@chunks/AI/documentEditAgent';
import { createEmbedStore } from './embedStore';

// Node's test fetch cannot load the browser WASM URL; use the Node build.
vi.mock('loro-crdt/web', () => import('loro-crdt/nodejs'));

const AGENT = 'atomic:agent:pZyZYvKoOcwczHXJoYvYctgrHXn2pZ7qfeWMyoUfQ_8';
const DRIVE = 'atomic:50cViRzEn58gVUYWYypS4CRIFwx4AvFVtNjxLMCc5tg4p0DLZmnD2YV';
const driveJsonAd = JSON.stringify({
  '@id': DRIVE,
  [core.properties.isA]: [server.classes.drive],
  [core.properties.name]: 'Drive',
});

/** The app's side with a signing key: enough for the page to mint and save. */
const channel: NativeChannel = {
  async call(method, args) {
    switch (method) {
      case 'init':
        return true;
      case 'agent':
        return AGENT;
      case 'publicKey':
        return Buffer.alloc(32, 7).toString('base64');
      case 'signBytes':
      case 'sign':
        // URL-safe, as a real signature is: the subject is made from it.
        return Buffer.from(Array.from({ length: 64 }, (_, i) => 251 - i))
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
      case 'getResourcesWithSnapshots':
        return (args[0] as string[]).map(s => ({
          jsonAd: s === DRIVE ? driveJsonAd : null,
          snapshot: null,
        }));
      case 'query':
        return { subjects: [], resources: [], count: 0 };
      case 'outboxEntries':
        return [];
      default:
        return null;
    }
  },
};

async function create(cls: string) {
  const { store } = await createEmbedStore(channel);
  await store.getResource(DRIVE);
  const created = await createResourceFromCompact(store, DRIVE, {
    '@class': cls,
    '@parent': DRIVE,
  });

  return { store, ...created };
}

// The model creates the document, then edits it by the ref the create returned.
// A document of any other class has no body, so every edit failed.
it.each([
  'document',
  'document-v2',
  'documentV2',
  'DocumentV2',
  'Document V2',
  dataBrowser.classes.documentV2,
  // The legacy Document class has no editable body.
  dataBrowser.classes.document,
])('creates an editable document from "@class": %s', async cls => {
  const { store, subject, classes } = await create(cls);
  const ref = shortenSubject(subject);

  expect(ref).toMatch(/^#/);
  expect(expandSubject(ref)).toBe(subject);

  const resource = await store.getResource(expandSubject(ref));

  expect(resource.getClasses()).toEqual([dataBrowser.classes.documentV2]);
  expect(hasDocumentContent(resource)).toBe(true);
  expect(classes).toHaveLength(1);
});

it('names the class of a resource that cannot be edited as a document', async () => {
  const { store, subject } = await create('folder');
  const result = await runDocumentEdit(
    store,
    () => undefined,
    { id: 'x', provider: 'x' } as never,
    subject,
    'add text',
    '<edit>hi</edit>',
    () => undefined,
  );

  expect(result).toMatch(/^Error: /);
  expect(result).toContain('Folder');
  expect(result).toContain(dataBrowser.classes.documentV2);
});
