import type { JSX } from 'react';
import { dataBrowser, useString } from '@tomic/react';
import { Column, Row } from '../../components/Row';
import { ResourceCardTitle } from '../Card/ResourceCardTitle';
import { ResourceContextMenu } from '../../components/ResourceContextMenu';
import { ResourceInline } from '../ResourceInline';
import type { CardViewProps } from '../Card/CardViewProps';
import { HideInPrint } from '../../components/HideInPrint';

export function ContactCard({ resource }: CardViewProps): JSX.Element {
  const [email] = useString(resource, dataBrowser.properties.email);
  const [telephone] = useString(resource, dataBrowser.properties.telephone);
  const [organization] = useString(
    resource,
    dataBrowser.properties.organization,
  );
  const [agent] = useString(resource, dataBrowser.properties.contactAgent);
  const meta = [organization, email, telephone].filter(Boolean).join(' · ');

  return (
    <Column gap='0.5rem'>
      <ResourceCardTitle resource={resource}>
        <Row center gap='1ch'>
          <span>Contact</span>
          <HideInPrint>
            <ResourceContextMenu simple subject={resource.subject} />
          </HideInPrint>
        </Row>
      </ResourceCardTitle>
      {meta && <div>{meta}</div>}
      {agent && <ResourceInline subject={agent} />}
    </Column>
  );
}
