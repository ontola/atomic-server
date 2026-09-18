import type { JSX } from 'react';
import { Column, Row } from '../../components/Row';
import { ResourceCardTitle } from '../Card/ResourceCardTitle';
import { ResourceContextMenu } from '../../components/ResourceContextMenu';
import type { CardViewProps } from '../Card/CardViewProps';
import { HideInPrint } from '../../components/HideInPrint';

export function AddressBookCard({ resource }: CardViewProps): JSX.Element {
  return (
    <Column gap='0.5rem'>
      <ResourceCardTitle resource={resource}>
        <Row center gap='1ch'>
          <span>Address Book</span>
          <HideInPrint>
            <ResourceContextMenu simple subject={resource.subject} />
          </HideInPrint>
        </Row>
      </ResourceCardTitle>
    </Column>
  );
}
