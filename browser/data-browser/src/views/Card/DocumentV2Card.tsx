import { Column, Row } from '@components/Row';
import type { CardViewProps } from './CardViewProps';
import { ResourceCardTitle } from './ResourceCardTitle';
import { dataBrowser, useArray } from '@tomic/react';
import { Tag } from '@components/Tag';
import { ResourceContextMenu } from '@components/ResourceContextMenu';
import { useDocumentText } from '@hooks/useDocumentText';

export const DocumentV2Card: React.FC<CardViewProps> = ({ resource }) => {
  const [tags] = useArray(resource, dataBrowser.properties.tags);
  const text = useDocumentText(resource, 300);

  return (
    <Column gap='0.5rem'>
      <ResourceCardTitle resource={resource}>
        <Row center gap='1ch'>
          <span>document</span>
          <ResourceContextMenu simple subject={resource.subject} />
        </Row>
      </ResourceCardTitle>
      <Row gap='1ch' style={{ fontSize: '0.8rem' }}>
        {tags.map(tag => (
          <Tag subject={tag} key={tag} />
        ))}
      </Row>
      <div>{text}</div>
    </Column>
  );
};
