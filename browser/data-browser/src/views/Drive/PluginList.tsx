import type { Resource, Server } from '@tomic/react';
import type React from 'react';
import { NewPluginButton } from './NewPluginButton';
import ResourceCard from '@views/Card/ResourceCard';
import { Column } from '@components/Row';

interface PluginListProps {
  drive: Resource<Server.Drive>;
}

export const PluginList: React.FC<PluginListProps> = ({ drive }) => {
  return (
    <div>
      <h2>Plugins</h2>
      <Column gap='1rem'>
        <NewPluginButton drive={drive} />
        {(drive.props.plugins ?? []).map(plugin => (
          <ResourceCard key={plugin} subject={plugin} />
        ))}
      </Column>
    </div>
  );
};

export default PluginList;
