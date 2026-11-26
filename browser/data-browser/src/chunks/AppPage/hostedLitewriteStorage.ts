import { type Store, core } from '@tomic/react';
import {
  ALL_MEMBERS_CAP,
  parseViewQuery,
  runViewQuery,
} from '@helpers/extensions/viewQuery';
import { handleRequest } from './hostStore';

type Note = {
  id: string;
  title: string;
  content: string;
  lastEdited: number | null;
  cursorPos: number;
  public: null;
};

type Request = {
  id: number;
  op: 'list' | 'get' | 'put' | 'delete';
  key?: unknown;
  note?: unknown;
};

const PREFIX = 'litewrite-note/v1\n';
const NOTE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_CONTENT = 256 * 1024;

function documentOf(value: unknown): Note {
  if (!value || typeof value !== 'object') throw new Error('Invalid note');
  const note = value as Partial<Note>;
  if (
    typeof note.id !== 'string' || !NOTE_ID.test(note.id) ||
    typeof note.title !== 'string' || note.title.length > 256 ||
    typeof note.content !== 'string' || note.content.length > MAX_CONTENT ||
    (note.lastEdited !== null &&
      (typeof note.lastEdited !== 'number' || !Number.isSafeInteger(note.lastEdited))) ||
    typeof note.cursorPos !== 'number' || !Number.isSafeInteger(note.cursorPos) ||
    note.cursorPos < 0
  ) throw new Error('Invalid note');

  return {
    id: note.id,
    title: note.title,
    content: note.content,
    lastEdited: note.lastEdited ?? null,
    cursorPos: note.cursorPos,
    public: null,
  };
}

/** The hosted page receives notes from this app's own table, never a Store. */
export function hostedLitewriteStorage(
  store: Store,
  app: string,
  drive: string,
  canRespond: () => boolean,
) {
  function assertOpen() {
    if (!canRespond()) throw new Error('Atomic session ended');
  }

  return async (request: Request) => {
    assertOpen();
    const { id, op, key } = request;
    if (!['list', 'get', 'put', 'delete'].includes(op)) {
      throw new Error('Unknown Litewrite operation');
    }
    const data = await handleRequest(store, app, drive, {
      __atomic: true, id: request.id, op: 'data',
    }) as { table?: string; rowClass?: string } | undefined;
    if (!data?.table || !data.rowClass) throw new Error('Litewrite needs its own app table');
    const table = await store.getResource(data.table);
    if (table.error || table.get(core.properties.parent) !== app) {
      throw new Error('Litewrite needs its own app table');
    }

    if (op !== 'list' && (typeof key !== 'string' || !NOTE_ID.test(key))) {
      throw new Error('Invalid note id');
    }

    const subjects = await runViewQuery(store, parseViewQuery({
      property: core.properties.parent,
      value: data.table,
      filters: [
        { property: core.properties.isA, value: data.rowClass },
        ...(op === 'list' ? [] : [{ property: core.properties.shortname, value: key }]),
      ],
    }));
    if (subjects.length >= ALL_MEMBERS_CAP) throw new Error('Too many notes in this preview');

    const notes = new Map<string, { subject: string; document: Note }>();
    const rows = await Promise.all(subjects.map(subject => store.getResource(subject)));
    for (const row of rows) {
      if (row.error || row.get(core.properties.parent) !== data.table ||
        !row.hasClasses(data.rowClass)) continue;

      const value = row.get(core.properties.description);
      if (typeof value !== 'string' || !value.startsWith(PREFIX)) continue;
      const document = documentOf(JSON.parse(value.slice(PREFIX.length)));
      if (row.get(core.properties.shortname) !== document.id) continue;
      if (notes.has(document.id)) throw new Error('Duplicate note id');
      notes.set(document.id, { subject: row.subject, document });
    }
    assertOpen();

    if (op === 'list') {
      return Object.fromEntries([...notes].map(([id, row]) => [id, row.document]));
    }
    // The frame can supply an id. The host alone resolves it to a subject.
    const existing = typeof key === 'string' ? notes.get(key) : undefined;
    if (op === 'get') return existing?.document;
    if (op === 'delete') {
      if (existing) await handleRequest(store, app, drive, {
        __atomic: true, id, op: 'destroy', subject: existing.subject,
      });

      return null;
    }

    const document = documentOf(request.note);
    if (document.id !== key) throw new Error('Note id mismatch');
    const propVals = {
      [core.properties.name]: document.title || 'Note',
      [core.properties.shortname]: document.id,
      [core.properties.description]: PREFIX + JSON.stringify(document),
    };
    await handleRequest(store, app, drive, existing
      ? { __atomic: true, id, op: 'save', subject: existing.subject, propVals }
      : { __atomic: true, id, op: 'create', parent: data.table, isA: [data.rowClass], propVals });

    return null;
  };
}
