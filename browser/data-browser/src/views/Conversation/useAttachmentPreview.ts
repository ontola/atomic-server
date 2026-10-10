import { useStore } from '@tomic/react';
import { useEffect, useState } from 'react';
import {
  isRasterImage,
  type SealedAttachment,
} from '../../helpers/conversations/attachments';
import { loadAttachment } from '../../helpers/conversations/openAttachment';

export type AttachmentPreview =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'failed' };

type Settled = { blob: string; url: string } | { blob: string; failed: true };

/**
 * An object URL for an attachment that is a raster image, once it is fetched
 * and decrypted. Nothing else is previewed: the type is the sender's word, so
 * it only ever picks between "show as an image" (allowlist) and "offer a
 * download". The URL is revoked when the message goes away.
 */
export function useAttachmentPreview(
  conversation: string,
  attachment: SealedAttachment,
  enabled: boolean,
): AttachmentPreview {
  const store = useStore();
  const [settled, setSettled] = useState<Settled>();
  const { blob, key, type } = attachment;
  const eligible = enabled && isRasterImage(type);

  // Keyed by the parts that decide what is shown, so a payload that is read
  // again (new object, same file) does not fetch and revoke twice.
  useEffect(() => {
    if (!eligible) return;

    const controller = new AbortController();
    let url: string | undefined;

    loadAttachment(
      store,
      conversation,
      { blob, key, type, name: '', size: 0 },
      controller.signal,
    )
      .then(bytes => {
        if (controller.signal.aborted) return;

        // Typed from the allowlist, never from free text.
        url = URL.createObjectURL(
          new Blob([bytes as BlobPart], { type: type.toLowerCase() }),
        );
        setSettled({ blob, url });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setSettled({ blob, failed: true });
        }
      });

    return () => {
      controller.abort();

      if (url) URL.revokeObjectURL(url);
    };
  }, [store, conversation, blob, key, type, eligible]);

  if (!eligible) return { status: 'idle' };

  if (settled?.blob !== blob) return { status: 'loading' };

  return 'url' in settled
    ? { status: 'ready', url: settled.url }
    : { status: 'failed' };
}
