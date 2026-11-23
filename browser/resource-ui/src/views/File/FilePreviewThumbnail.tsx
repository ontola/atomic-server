import { resourceTheme } from '../../theme.js';
import { Resource, server, useNumber, useString } from '@tomic/react';
import { FaTriangleExclamation } from 'react-icons/fa6';
import { useFilePreviewSizeLimit } from '../../hooks/useFilePreviewSizeLimit.js';
import { useFileImageTransitionStyles } from './useFileImageTransitionStyles.js';
import { useFileInfo } from '../../hooks/useFile.js';
import { Thumbnail } from '../../components/Thumbnail.js';
import { isImageFile, isTextFile } from './fileTypeUtils.js';
import { styled } from 'styled-components';
import { InnerWrapper } from '../FolderPage/GridItem/components.js';
import { TextPreview } from './TextPreview.js';
import { ErrorBoundary } from '../../components/ErrorBoundary.js';
import { Row } from '@tomic/ui/components/Row';

import type { JSX } from 'react';

interface FilePreviewThumbnailProps {
  resource: Resource;
}

export function FilePreviewThumbnail(
  props: FilePreviewThumbnailProps,
): JSX.Element {
  const { resource } = props;
  const [mimeType] = useString(resource, server.properties.mimetype);
  const [bytes] = useNumber(resource, server.properties.filesize);

  // A File that finished loading without its file properties (404,
  // unauthorized, another server) cannot be previewed. Say so here instead of
  // letting `useFileInfo` throw, which would be reported as an error. The
  // download URL is not checked: a local-first File can be shown from its
  // local bytes before the server knows it.
  const unavailable =
    !resource.loading &&
    (!!resource.error || mimeType === undefined || bytes === undefined);

  if (unavailable) {
    return <PreviewError />;
  }

  return (
    <ErrorBoundary FallBackComponent={PreviewError}>
      <FilePreviewThumbnailInner {...props} />
    </ErrorBoundary>
  );
}

function PreviewError(): JSX.Element {
  return (
    <TextWrapper error>
      <Row gap='1ch' center>
        <FaTriangleExclamation />
        Could not display file preview.
      </Row>
    </TextWrapper>
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
  color: ${p =>
    p.error
      ? resourceTheme(p.theme).colors.alert
      : resourceTheme(p.theme).colors.textLight};
`;

const StyledTextPreview = styled(TextPreview)`
  padding: ${p => resourceTheme(p.theme).size()};
  color: ${p => resourceTheme(p.theme).colors.textLight};

  &:is(pre) {
    padding: 0;
    padding-inline: ${p => resourceTheme(p.theme).size()};
  }
`;
