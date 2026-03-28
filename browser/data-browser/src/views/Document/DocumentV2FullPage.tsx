import { EditableTitle } from '@components/EditableTitle';
import { dataBrowser, useYDoc } from '@tomic/react';
import type { ResourcePageProps } from '@views/ResourcePage';
import { lazy, Suspense } from 'react';
import styled from 'styled-components';
import {
  useCustomContextItems,
  DIVIDER,
} from '@components/ResourceContextMenu';
import { FaFilePdf } from 'react-icons/fa6';

const CollaborativeEditor = lazy(
  () => import('@chunks/RTE/CollaborativeEditor'),
);

const customMenuItems = [
  DIVIDER,
  {
    id: 'print-document',
    label: 'Export to PDF',
    helper: 'Print this document to a PDF file',
    icon: <FaFilePdf />,
    onClick: () => window.print(),
  },
];

export const DocumentV2FullPage: React.FC<ResourcePageProps> = ({
  resource,
}) => {
  const doc = useYDoc(resource, dataBrowser.properties.documentContent);

  useCustomContextItems(customMenuItems);

  if (!doc) {
    return <div>Loading...</div>;
  }

  const focusEditor = () => {
    document.getElementById('document-editor')?.focus();
  };

  return (
    <FullPageWrapper>
      <DocumentContainer>
        <EditableTitle resource={resource} onCommit={focusEditor} />

        <Suspense fallback={<div>Loading...</div>}>
          <CollaborativeEditor
            id='document-editor'
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
  @media print {
    min-height: 100vh;
  }
`;

const DocumentContainer = styled.div`
  width: min(100%, ${p => p.theme.containerWidthWide});
  margin: auto;
  display: flex;
  gap: ${p => p.theme.size()};
  flex: 1;
  flex-direction: column;
  padding: ${p => p.theme.size(7)};
  h1 {
    margin-bottom: 0;
  }
  @media (max-width: ${props => props.theme.containerWidthWide}) {
    padding: ${p => p.theme.size()};
  }
`;
