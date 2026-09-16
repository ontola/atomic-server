import { Resource } from '@tomic/react';
import { FaTriangleExclamation } from 'react-icons/fa6';
import { useFilePreviewSizeLimit } from '../../hooks/useFilePreviewSizeLimit';
import { useFileImageTransitionStyles } from './useFileImageTransitionStyles';
import { useFileInfo } from '../../hooks/useFile';
import { Thumbnail } from '../../components/Thumbnail';
import { isImageFile, isTextFile } from './fileTypeUtils';
import { styled } from 'styled-components';
import { InnerWrapper } from '../FolderPage/GridItem/components';
import { TextPreview } from './TextPreview';
import { ErrorBoundary } from '../ErrorPage';
import { Row } from '../../components/Row';

import type { JSX } from 'react';

interface FilePreviewThumbnailProps {
  resource: Resource;
}

export function FilePreviewThumbnail(
  props: FilePreviewThumbnailProps,
): JSX.Element {
  return (
    <ErrorBoundary
      FallBackComponent={() => (
        <TextWrapper error>
          <Row gap='1ch' center>
            <FaTriangleExclamation />
            Could not display file preview.
          </Row>
        </TextWrapper>
      )}
    >
      <FilePreviewThumbnailInner {...props} />
    </ErrorBoundary>
  );
}

function FilePreviewThumbnailInner({
  resource,
}: FilePreviewThumbnailProps): JSX.Element {
  const { downloadUrl, mimeType, bytes, loading } = useFileInfo(resource);
  const previewSizeLimit = useFilePreviewSizeLimit();
  const transitionStyles = useFileImageTransitionStyles(resource.subject);

  if (loading) {
    return <TextWrapper>Loading...</TextWrapper>;
  }

  if (bytes >= previewSizeLimit) {
    return <TextWrapper>To large for preview</TextWrapper>;
  }

  if (isImageFile(mimeType)) {
    return <Thumbnail subject={resource.subject} style={transitionStyles} />;
  }

  if (isTextFile(mimeType)) {
    return (
      <StyledTextPreview
        nestedInLink
        downloadUrl={downloadUrl}
        mimeType={mimeType}
      />
    );
  }

  return <TextWrapper>No preview available</TextWrapper>;
}

const TextWrapper = styled(InnerWrapper)<{ error?: boolean }>`
  display: grid;
  place-items: center;
  color: ${p => (p.error ? 'var(--color-alert)' : 'var(--color-text-subtle)')};
`;

const StyledTextPreview = styled(TextPreview)`
  padding: var(--space-3);
  color: var(--color-text-subtle);

  &:is(pre) {
    padding: 0;
    padding-inline: var(--space-3);
  }
`;
