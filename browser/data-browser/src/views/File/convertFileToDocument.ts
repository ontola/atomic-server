import {
  core,
  dataBrowser,
  enableLoro,
  server,
  type Resource,
  type Store,
} from '@tomic/react';
import type { JSONContent } from '@tiptap/core';

export type ConvertibleTextFileKind = 'markdown' | 'plain-text';

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Uploads store their original filename in the server metadata property. */
export function getUploadedFileName(resource: Resource): string | undefined {
  return (
    nonEmptyString(resource.get(server.properties.filename)) ??
    nonEmptyString(resource.get(core.properties.name))
  );
}

/** DocumentV2 requires a name, while legacy File uploads only have filename. */
export async function ensureDocumentName(resource: Resource): Promise<void> {
  if (nonEmptyString(resource.get(core.properties.name))) {
    return;
  }

  const name = getUploadedFileName(resource) ?? nonEmptyString(resource.title);

  if (!name) {
    throw new Error('This file needs a name before it can become a document.');
  }

  await resource.set(core.properties.name, name, false);
}

function normalizedMimeType(mimeType: string | undefined): string {
  return mimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

/** The conversion deliberately has a narrow allow-list: code and HTML remain files. */
export function getConvertibleTextFileKind(
  name: string | undefined,
  mimeType: string | undefined,
): ConvertibleTextFileKind | undefined {
  const normalizedName = name?.trim().toLowerCase() ?? '';
  const normalizedMime = normalizedMimeType(mimeType);

  if (
    normalizedName.endsWith('.md') ||
    normalizedName.endsWith('.markdown') ||
    normalizedMime === 'text/markdown' ||
    normalizedMime === 'text/x-markdown'
  ) {
    return 'markdown';
  }

  if (normalizedName.endsWith('.txt') || normalizedMime === 'text/plain') {
    return 'plain-text';
  }
}

/**
 * Represents every source newline as a hard break in one literal paragraph.
 * This intentionally does not run plain text through the Markdown parser.
 */
export function plainTextToTiptapJson(text: string): JSONContent {
  const content: JSONContent[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  lines.forEach((line, index) => {
    if (line) {
      content.push({ type: 'text', text: line });
    }

    if (index < lines.length - 1) {
      content.push({ type: 'hardBreak' });
    }
  });

  return {
    type: 'doc',
    content: [{ type: 'paragraph', ...(content.length ? { content } : {}) }],
  };
}

function markdownParseToJson(parsed: unknown): JSONContent {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('The Markdown file could not be parsed.');
  }

  const candidate = parsed as {
    content?: JSONContent[];
    toJSON?: () => JSONContent;
  };
  const json =
    candidate.toJSON?.() ??
    (Array.isArray(candidate.content)
      ? { type: 'doc', content: candidate.content }
      : undefined);

  if (!json || json.type !== 'doc') {
    throw new Error('The Markdown file did not produce a document.');
  }

  return json.content?.length
    ? json
    : { type: 'doc', content: [{ type: 'paragraph' }] };
}

export async function fileContentsToTiptapJson(
  text: string,
  kind: ConvertibleTextFileKind,
  store: Store,
): Promise<JSONContent> {
  if (kind === 'plain-text') {
    return plainTextToTiptapJson(text);
  }

  const { MarkdownManager } = await import('@tiptap/markdown');
  const { getCollaborativeEditorSchema } =
    await import('@chunks/RTE/getCollaborativeEditorSchema');
  const { extensions } = getCollaborativeEditorSchema(store);

  return markdownParseToJson(new MarkdownManager({ extensions }).parse(text));
}

async function assertCanWrite(resource: Resource, store: Store): Promise<void> {
  const agent = store.getAgent();

  if (!agent) {
    throw new Error('You need to be signed in to convert this file.');
  }

  const [canWrite] = await resource.canWrite(agent.subject);

  if (!canWrite) {
    throw new Error('You do not have permission to convert this file.');
  }
}

export function replacementClasses(resource: Resource): string[] {
  const classes = resource.get(core.properties.isA);
  const current = Array.isArray(classes) ? classes : [];

  if (current.includes(dataBrowser.classes.documentV2)) {
    throw new Error('This file is already a document.');
  }

  if (!current.includes(server.classes.file)) {
    throw new Error('This resource is no longer a file.');
  }

  return current.map(classSubject =>
    classSubject === server.classes.file
      ? dataBrowser.classes.documentV2
      : classSubject,
  );
}

const inFlight = new Map<string, Promise<void>>();

export class DocumentConversionSaveError extends Error {
  public constructor(cause: unknown) {
    /* @wc-ignore */
    super('Document converted locally, but could not be saved.');
    /* @wc-ignore */
    this.name = 'DocumentConversionSaveError';
    this.cause = cause;
  }
}

/**
 * Converts an uploaded Markdown or plain-text File in place. The file's
 * existing Loro snapshot is staged on a clone so fetch/parse/schema failures
 * never change the live File resource. Blob and recovery metadata are retained
 * because only its class and document body are changed.
 */
export async function convertFileToDocument(options: {
  resource: Resource;
  store: Store;
  downloadUrl: string;
  mimeType: string;
}): Promise<void> {
  const existing = inFlight.get(options.resource.subject);

  if (existing) {
    return existing;
  }

  const promise = convertFileToDocumentInner(options).finally(() => {
    inFlight.delete(options.resource.subject);
  });

  inFlight.set(options.resource.subject, promise);

  return promise;
}

async function convertFileToDocumentInner(options: {
  resource: Resource;
  store: Store;
  downloadUrl: string;
  mimeType: string;
}): Promise<void> {
  const { resource, store, downloadUrl, mimeType } = options;
  const name = getUploadedFileName(resource);
  const kind = getConvertibleTextFileKind(name, mimeType);

  if (!kind) {
    throw new Error('Only Markdown and plain text files can be converted.');
  }

  if (resource.hasClasses(dataBrowser.classes.documentV2)) {
    throw new Error('This file is already a document.');
  }

  replacementClasses(resource);
  await assertCanWrite(resource, store);

  const response = await fetch(downloadUrl);

  if (!response.ok) {
    throw new Error(`Could not read the file (${response.status}).`);
  }

  const text = await response.text();
  const patchedJson = await fileContentsToTiptapJson(text, kind, store);
  const { getCollaborativeEditorSchema } =
    await import('@chunks/RTE/getCollaborativeEditorSchema');

  // Validate before touching any Loro document. This also catches malformed
  // Markdown output before the File class can change.
  getCollaborativeEditorSchema(store).schema.nodeFromJSON(patchedJson).check();

  // The read and parsing work above can take a while. Confirm this is still
  // the same writable File before changing its visible class.
  replacementClasses(resource);
  await assertCanWrite(resource, store);

  await enableLoro();
  const staged = resource.clone();
  staged.setStore(store);
  const stagedLoroDoc = staged.getLoroDoc();

  if (!stagedLoroDoc) {
    throw new Error('Document storage is not ready.');
  }

  const { applyPatchedJsonToLoroDocCollaborative } =
    await import('@chunks/RTE/applyPatchedJsonToLoroDocCollaborative');

  await applyPatchedJsonToLoroDocCollaborative({
    store,
    loroDoc: stagedLoroDoc,
    // This clone must never dispatch through an editor that happened to open
    // while we were fetching the file. A staging-only subject forces the
    // helper's headless-editor path for the cloned Loro document.
    subject: `${resource.subject}#conversion-staging`,
    patchedJson,
  });
  await ensureDocumentName(staged);
  await staged.set(core.properties.isA, replacementClasses(resource));
  staged.markDirty();

  // Do not overwrite a remote conversion or permission update that arrived
  // while the headless editor was preparing the clone.
  // Merge the prepared clone only after the body has been successfully
  // materialized. `merge` retains the File's subject, parent, ACL and all blob
  // metadata while bringing its existing Loro history forward.
  replacementClasses(resource);
  await assertCanWrite(resource, store);
  // `canWrite` is async, so one final class check keeps an incoming remote
  // conversion from being overwritten between the permission check and merge.
  replacementClasses(resource);
  resource.merge(staged);
  resource.markDirty();

  try {
    await resource.save();
  } catch (error) {
    // The Loro body and class are now a durable local edit where possible;
    // do not falsely describe this as an untouched File.
    throw new DocumentConversionSaveError(error);
  }
}
