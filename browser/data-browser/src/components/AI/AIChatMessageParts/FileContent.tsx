import type { FileUIPart, ImagePart } from 'ai';
import { FaFile } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { ImageViewer } from '../../ImageViewer';
import { useId } from 'react';

export const FileContent = ({ part }: { part: FileUIPart }) => {
  // Display filename/title based on what's available
  // FilePart has data and mimeType properties
  if (part.mediaType.startsWith('image/')) {
    return <ImageContent part={part} />;
  }

  return (
    <MessageFileWrapper>
      <FaFile />
      {part.filename ?? 'Attached File'}
    </MessageFileWrapper>
  );
};

interface ImageContentProps {
  part: FileUIPart;
}

export function isImagePart(part: unknown): part is ImagePart {
  return (
    !!part &&
    typeof part === 'object' &&
    'type' in part &&
    part.type === 'image'
  );
}

export const ImageContent: React.FC<ImageContentProps> = ({ part }) => {
  const id = useId();

  return (
    <MessageImageWrapper>
      <ImageViewer src={part.url} alt='' subject={`image-${id}.png`} />
    </MessageImageWrapper>
  );
};

const MessageFileWrapper = styled.div`
  margin: ${p => p.theme.size(1)} 0;

  background-color: ${p => p.theme.colors.bg1};
  padding: ${p => p.theme.size(1)};
  border-radius: ${p => p.theme.radius};
`;

const MessageImageWrapper = styled.div`
  margin: ${p => p.theme.size(1)} 0;

  img {
    max-width: 100%;
    max-height: 300px;
    border-radius: ${p => p.theme.radius};
  }
`;
