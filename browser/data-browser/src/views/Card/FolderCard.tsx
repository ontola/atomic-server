import { Column, Row } from '@components/Row';
import type { CardViewProps } from './CardViewProps';
import { ResourceCardTitle } from './ResourceCardTitle';
import { dataBrowser, useArray, useResources } from '@tomic/react';
import { Tag } from '@components/Tag';
import { ResourceContextMenu } from '@components/ResourceContextMenu';
import { ListView } from '@views/FolderPage/ListView';
import { styled } from 'styled-components';

export const FolderCard: React.FC<CardViewProps> = ({ resource }) => {
  const [tags] = useArray(resource, dataBrowser.properties.tags);
  const [subResourcesSubjects] = useArray(
    resource,
    dataBrowser.properties.subResources,
  );
  const subResources = useResources(subResourcesSubjects);

  return (
    <Column gap='0.5rem'>
      <ResourceCardTitle resource={resource}>
        <Row center gap='1ch'>
          <span>folder</span>
          <ResourceContextMenu simple subject={resource.subject} />
        </Row>
      </ResourceCardTitle>
      <Row gap='1ch' style={{ fontSize: '0.8rem' }}>
        {tags.map(tag => (
          <Tag subject={tag} key={tag} />
        ))}
      </Row>
      <TableWrapper>
        <ListView
          basic
          parent={resource.subject}
          subResources={subResources}
          onNewClick={() => {}}
          showNewButton={false}
        />
      </TableWrapper>
    </Column>
  );
};

const TableWrapper = styled.div`
  max-height: 20rem;
  overflow-y: auto;
`;
