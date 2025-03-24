import type { ImagePart } from 'ai';
import { styled } from 'styled-components';

interface ImageContentProps {
  imagePart: ImagePart;
}

export function isImagePart(part: unknown): part is ImagePart {
  return (
    !!part &&
    typeof part === 'object' &&
    'type' in part &&
    part.type === 'image'
  );
}

export const ImageContent: React.FC<ImageContentProps> = ({ imagePart }) => {
  const imageSrc =
    typeof imagePart.image === 'string'
      ? imagePart.image
      : 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='; // Fallback 1x1 transparent image

  return (
    <MessageImageWrapper>
      <img src={imageSrc} alt='' />
    </MessageImageWrapper>
  );
};

const MessageImageWrapper = styled.div`
  margin: ${p => p.theme.size(1)} 0;

  img {
    max-width: 100%;
    max-height: 300px;
    border-radius: ${p => p.theme.radius};
  }
`;
