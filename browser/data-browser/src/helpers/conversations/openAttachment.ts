import { hexToBytes, type Store } from '@tomic/react';
import {
  hashOfBlobReference,
  safeFileName,
  type SealedAttachment,
} from './attachments';
import { openFile } from './conversationCrypto';

/**
 * Reading an attachment back: fetch the ciphertext, decrypt it with the key
 * from the sealed message, and keep the plaintext in memory only. It is never
 * written to the blob store, which holds ciphertext alone.
 */

/** Waits between attempts. The message can arrive before the upload of its
 *  files has finished, so a missing blob is retried for a while. */
const RETRY_DELAYS_MS = [0, 1000, 2500, 5000, 10000];

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(/* @wc-ignore */ 'Cancelled'));

      return;
    }

    if (ms === 0) {
      resolve();

      return;
    }

    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error(/* @wc-ignore */ 'Cancelled'));
      },
      { once: true },
    );
  });
}

/** The ciphertext from this device's blob store, or from the server. */
async function fetchOnce(
  store: Store,
  hash: string,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> {
  const clientDb = store.getClientDb();
  const hashBytes = hexToBytes(hash);

  try {
    const local = await clientDb?.getBlob(hashBytes);

    if (local) return local;
  } catch {
    // Fall through to the server.
  }

  // Unauthenticated by design: the hash is the capability, and what it names
  // is ciphertext.
  const response = await fetch(
    `${store.getServerUrl()}/download/files/${hash}`,
    {
      signal,
    },
  );

  if (!response.ok) return undefined;

  const bytes = new Uint8Array(await response.arrayBuffer());

  // Keep it for next time. Best effort: this is a cache, not the source.
  clientDb?.putBlob(hashBytes, bytes).catch(() => undefined);

  return bytes;
}

/** The decrypted bytes of an attachment. Rejects when it never shows up or
 *  cannot be decrypted. */
export async function loadAttachment(
  store: Store,
  conversation: string,
  attachment: SealedAttachment,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const hash = hashOfBlobReference(attachment.blob);

  if (!hash) {
    throw new Error('This attachment has no valid reference.');
  }

  let ciphertext: Uint8Array | undefined;

  for (const delay of RETRY_DELAYS_MS) {
    await wait(delay, signal);

    try {
      ciphertext = await fetchOnce(store, hash, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
    }

    if (ciphertext) break;
  }

  if (!ciphertext) {
    throw new Error('The file could not be fetched.');
  }

  return openFile(conversation, attachment.key, ciphertext);
}

/** Saves an attachment under its own name. The bytes are handed to the browser
 *  as `application/octet-stream`, whatever type the sender claimed. */
export async function downloadAttachment(
  store: Store,
  conversation: string,
  attachment: SealedAttachment,
): Promise<void> {
  const bytes = await loadAttachment(store, conversation, attachment);
  const url = URL.createObjectURL(
    new Blob([bytes as BlobPart], { type: 'application/octet-stream' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = safeFileName(attachment.name);
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before the URL goes.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
