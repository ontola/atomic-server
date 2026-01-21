import { Column } from '@components/Row';
import { core, server, useString } from '@tomic/react';
import type { CardViewProps } from '@views/Card/CardViewProps';
import { ResourceCardTitle } from '@views/Card/ResourceCardTitle';

export const PluginCard: React.FC<CardViewProps> = ({ resource }) => {
  const [name] = useString(resource, core.properties.name);
  const [namespace] = useString(resource, server.properties.namespace);

  const title = `${namespace ? `${namespace}/` : ''}${name}`;

  return (
    <Column gap='0.5rem'>
      <ResourceCardTitle resource={resource} alternateTitle={title} />
    </Column>
  );
}
