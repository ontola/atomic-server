import {
  executeServerPlugin,
  DEFAULT_ACCEPT_MAX_BYTES,
  type DeclaredAccept,
  type JSONObject,
  type Store,
} from '@tomic/react';

/**
 * Handing a file to an importer that declares `accepts`: the pieces the
 * plugin page's Import tab and an app's `store.importer.run()` share, so both
 * enforce the same limit and send the importer the same `input.upload`.
 */

/** A file as the importer receives it. */
export interface ImportUpload {
  name: string;
  mediaType: string;
  size: number;
  text: string;
}

/** The largest file any of the importer's `accepts` entries takes. */
export function maxBytes(accepts: DeclaredAccept[]): number {
  return Math.max(
    0,
    ...accepts.map(accept => accept.maxBytes ?? DEFAULT_ACCEPT_MAX_BYTES),
  );
}

/** The `accept` attribute for a file input, from the declared types. */
export function acceptAttribute(accepts: DeclaredAccept[]): string | undefined {
  const values = accepts.flatMap(accept => [
    ...(accept.extensions ?? []),
    ...(accept.mediaTypes ?? []),
  ]);

  return values.length ? values.join(',') : undefined;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024)
    return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;

  return `${bytes} bytes`;
}

/** Refuses a file larger than the importer accepts, before it is read. */
export function checkSize(size: number, accepts: DeclaredAccept[]): void {
  const max = maxBytes(accepts);

  if (size > max)
    throw new Error(
      `This file is ${formatBytes(size)}; this importer accepts at most ${formatBytes(max)}. Export a shorter period.`,
    );
}

/** UTF-8 when the file is valid UTF-8; older bank exports are often Windows-1252. */
export function decode(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** A picked file, size-checked and decoded. */
export async function readUpload(
  file: File,
  accepts: DeclaredAccept[],
): Promise<ImportUpload> {
  checkSize(file.size, accepts);

  return {
    name: file.name,
    mediaType: file.type,
    size: file.size,
    text: decode(await file.arrayBuffer()),
  };
}

/**
 * Runs the importer on the server and returns the verdict it proposes.
 * Writes nothing: the verdict goes to the review, and only an approved review
 * writes.
 */
export async function previewImport(
  store: Store,
  {
    drive,
    plugin,
    source,
    config,
    upload,
  }: {
    drive: string;
    plugin: string;
    source: string;
    config: JSONObject;
    upload: ImportUpload;
  },
): Promise<string> {
  const result = await executeServerPlugin(store, {
    drive,
    plugin,
    source,
    input: {
      upload: { ...upload },
      config,
      trigger: {
        kind: 'manual',
        at: Date.now(),
        subject: plugin,
      },
    },
  });

  if (result.error || !result.verdict)
    throw new Error(result.error ?? 'The importer returned no preview.');

  return result.verdict;
}
