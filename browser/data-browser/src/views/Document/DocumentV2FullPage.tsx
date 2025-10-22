import { EditableTitle } from '@components/EditableTitle';
import { TagBar } from '@components/Tag/TagBar';
import { dataBrowser, useYDoc } from '@tomic/react';
import type { ResourcePageProps } from '@views/ResourcePage';
import { lazy, Suspense } from 'react';
import styled from 'styled-components';

const CollaborativeEditor = lazy(
  () => import('@chunks/RTE/CollaborativeEditor'),
);

export const DocumentV2FullPage: React.FC<ResourcePageProps> = ({
  resource,
}) => {
  const doc = useYDoc(resource, dataBrowser.properties.documentContent);

  if (!doc) {
    return <div>Loading...</div>;
  }

  return (
    <FullPageWrapper>
      <DocumentContainer>
        <EditableTitle resource={resource} />
        <TagBar resource={resource} />
        <Suspense fallback={<div>Loading...</div>}>
          <CollaborativeEditor
            resource={resource}
            doc={doc}
            property={dataBrowser.properties.documentContent}
          />
        </Suspense>
      </DocumentContainer>
    </FullPageWrapper>
  );
};

const FullPageWrapper = styled.div`
  background-color: ${p => p.theme.colors.bg};
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: ${p => p.theme.heights.fullPage};
  box-sizing: border-box;
`;

const DocumentContainer = styled.div`
  width: min(100%, ${p => p.theme.containerWidthWide});
  margin: auto;
  display: flex;
  flex: 1;
  flex-direction: column;
  padding: ${p => p.theme.size(7)};
  @media (max-width: ${props => props.theme.containerWidthWide}) {
    padding: ${p => p.theme.size()};
  }
`;
