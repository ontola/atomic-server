import type { DeclaredAccept } from './plugin-manifest.js';

/**
 * A file as a plugin receives it, in `input.upload` (`ctx.upload` in `run`).
 * The field that carries the content is named after the encoding the
 * matching `accepts` entry declared, so a plugin can tell them apart: `text`
 * for `as: 'text'` (the default), `base64` for `as: 'base64'`. `size` is the
 * file's byte size either way.
 */
export type PluginUpload = {
  name: string;
  mediaType: string;
  size: number;
} & ({ text: string } | { base64: string });

/**
 * The `accepts` entry a chosen file falls under: the first that names its
 * extension, then the first that names its media type, else the first entry
 * (the picker's filter is only a hint, so a file may match none).
 */
export function acceptFor(
  file: { name: string; type: string },
  accepts: DeclaredAccept[],
): DeclaredAccept | undefined {
  const name = file.name.toLowerCase();

  return (
    accepts.find(accept =>
      accept.extensions?.some(extension => name.endsWith(extension)),
    ) ??
    accepts.find(
      accept => file.type && accept.mediaTypes?.includes(file.type),
    ) ??
    accepts[0]
  );
}

/** Builds `input.upload` from a file's bytes, as `accept` declares. */
export function readUpload(
  file: { name: string; type: string },
  bytes: ArrayBuffer | Uint8Array,
  accept: DeclaredAccept,
): PluginUpload {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const meta = { name: file.name, mediaType: file.type, size: view.byteLength };

  return accept.as === 'base64'
    ? { ...meta, base64: encodeBase64(view) }
    : { ...meta, text: decodeUploadText(view) };
}

/** UTF-8 when the file is valid UTF-8; older bank exports are often Windows-1252. */
export function decodeUploadText(bytes: ArrayBuffer | Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Standard, padded base64 of exact bytes. Chunked: files run to megabytes. */
export function encodeBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = '';

  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));

  return btoa(binary);
}
