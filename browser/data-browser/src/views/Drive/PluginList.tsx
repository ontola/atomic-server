import type { Resource, Server } from '@tomic/react';
import type React from 'react';
import ResourceCard from '@views/Card/ResourceCard';
import { Column } from '@components/Row';
import { lazy, Suspense } from 'react';
import { Spinner } from '@components/Spinner';

const NewPluginButton = lazy(() => import('@chunks/Plugins/NewPluginButton'));
interface PluginListProps {
  drive: Resource<Server.Drive>;
}

export const PluginList: React.FC<PluginListProps> = ({ drive }) => {
  return (
    <div>
      <h2>Plugins</h2>
      <Column gap='1rem'>
        <Suspense fallback={<Spinner />}>
          <NewPluginButton drive={drive} />
          {(drive.props.plugins ?? []).map(plugin => (
            <ResourceCard key={plugin} subject={plugin} />
          ))}
        </Suspense>
      </Column>
    </div>
  );
};
