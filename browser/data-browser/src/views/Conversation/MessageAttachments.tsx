import { useStore } from '@tomic/react';
import { useState } from 'react';
import { styled } from 'styled-components';
import { FileChip } from '../../components/FileChip';
import { Spinner } from '../../components/Spinner';
import {
  isRasterImage,
  type SealedAttachment,
} from '../../helpers/conversations/attachments';
import { downloadAttachment } from '../../helpers/conversations/openAttachment';
import { useAttachmentPreview } from './useAttachmentPreview';

/** Images above this size are fetched when asked for, not when scrolled past. */
const INLINE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

const PREVIEW_MAX_WIDTH = 320;
const PREVIEW_MAX_HEIGHT = 240;

interface MessageAttachmentsProps {
  conversation: string;
  attachments: SealedAttachment[];
}

/** The files of one sealed message: raster images inline, the rest as chips to
 *  download. Decrypted on this device, on demand. */
export function MessageAttachments({
  conversation,
  attachments,
}: MessageAttachmentsProps) {
  return (
    <List>
      {attachments.map(attachment => (
        <Attachment
          key={attachment.blob}
          conversation={conversation}
          attachment={attachment}
        />
      ))}
    </List>
  );
}

function Attachment({
  conversation,
  attachment,
}: {
  conversation: string;
  attachment: SealedAttachment;
}) {
  const store = useStore();
  const [downloading, setDownloading] = useState(false);
  const [failed, setFailed] = useState(false);
  const inline =
    isRasterImage(attachment.type) &&
    attachment.size <= INLINE_PREVIEW_MAX_BYTES;
  const preview = useAttachmentPreview(conversation, attachment, inline);

  const handleDownload = () => {
    setDownloading(true);
    setFailed(false);
    downloadAttachment(store, conversation, attachment)
      .catch(() => setFailed(true))
      .then(() => setDownloading(false));
  };

  return (
    <Item>
      {preview.status === 'ready' && (
        <Image
          src={preview.url}
          alt={attachment.name}
          width={attachment.width}
          height={attachment.height}
        />
      )}
      {preview.status === 'loading' && (
        <Placeholder
          style={{
            aspectRatio:
              attachment.width && attachment.height
                ? `${attachment.width} / ${attachment.height}`
                : '4 / 3',
          }}
        >
          <Spinner size='1.5rem' />
        </Placeholder>
      )}
      <FileChip
        name={attachment.name}
        size={attachment.size}
        mimeType={attachment.type}
        busy={downloading}
        onClick={handleDownload}
        note={
          failed || preview.status === 'failed'
            ? 'This file could not be opened. Select it to try again.'
            : undefined
        }
      />
    </Item>
  );
}

const List = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 0.5rem;
  margin-top: 0.25rem;
`;

const Item = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.25rem;
  max-width: 100%;
`;

const Image = styled.img`
  display: block;
  max-width: min(100%, ${PREVIEW_MAX_WIDTH}px);
  max-height: ${PREVIEW_MAX_HEIGHT}px;
  width: auto;
  height: auto;
  border-radius: ${p => p.theme.radius};
  object-fit: contain;
`;

const Placeholder = styled.div`
  display: grid;
  place-items: center;
  width: min(100%, ${PREVIEW_MAX_WIDTH}px);
  max-height: ${PREVIEW_MAX_HEIGHT}px;
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.bg1};
`;
