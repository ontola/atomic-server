import Markdown from '@components/datatypes/Markdown';
import { HideInPrint } from '@components/HideInPrint';
import { ResourceContextMenu } from '@components/ResourceContextMenu';
import { Column, Row } from '@components/Row';
import { core, server, useResource, useString } from '@tomic/react';
import type { CardViewProps } from '@views/Card/CardViewProps';
import { ResourceCardTitle } from '@views/Card/ResourceCardTitle';

export const PluginCard: React.FC<CardViewProps> = ({ resource }) => {
  const [name] = useString(resource, core.properties.name);
  const [namespace] = useString(resource, server.properties.namespace);
  const isAResource = useResource(resource.props.isA[0]);

  const title = `${namespace ? `${namespace}/` : ''}${name}`;

  return (
    <Column gap='0.5rem'>
      <ResourceCardTitle resource={resource} alternateTitle={title}>
        <Row center gap='1ch'>
          <span>{isAResource.title}</span>
          <HideInPrint>
            <ResourceContextMenu simple subject={resource.subject} />
          </HideInPrint>
        </Row>
      </ResourceCardTitle>
      <Markdown text={resource.props.description ?? ''} maxLength={300} />
    </Column>
  );
};
