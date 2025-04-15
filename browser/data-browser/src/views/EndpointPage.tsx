import React from 'react';
import {
  properties,
  Resource,
  server,
  useArray,
  useResource,
  useStore,
  useString,
  useTitle,
} from '@tomic/react';

import { ContainerNarrow } from '../components/Containers';
import Markdown from '../components/datatypes/Markdown';
import ResourceField from '../components/forms/ResourceField';
import { Button } from '../components/Button';
import { constructOpenURL } from '../helpers/navigation';
import ResourceCard from './Card/ResourceCard';

import type { JSX } from 'react';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';

type EndpointProps = {
  resource: Resource;
};

/** A View for Endpoints. */
function EndpointPage({ resource }: EndpointProps): JSX.Element {
  const [title] = useTitle(resource);
  const [description] = useString(resource, properties.description);
  const [parameters] = useArray(resource, properties.endpoint.parameters);
  const [results] = useArray(resource, properties.endpoint.results);
  const isPost = resource.get(server.properties.isPost) === true;
  const virtualResource = useResource(undefined, { newResource: true });
  const store = useStore();
  const navigate = useNavigateWithTransition();
  const [hasQueried, setHasQueried] = React.useState(false);

  async function constructSubject(e?: React.SyntheticEvent) {
    e?.preventDefault();
    const url = new URL(resource.subject);

    await Promise.all(
      parameters.map(async propUrl => {
        const val = virtualResource.get(propUrl);

        // Skip params that are unset or explicitly false (e.g. boolean flags).
        if (val !== undefined && val !== false) {
          const fullprop = await store.getProperty(propUrl);
          url.searchParams.set(fullprop.shortname, val.toString());
        }
      }),
    );

    setHasQueried(true);

    if (isPost) {
      const response = await store.postToServer(url.href);
      navigate(constructOpenURL(response.subject));
    } else {
      navigate(constructOpenURL(url.href));
    }
  }

  return (
    <ContainerNarrow>
      <h1>{title} endpoint</h1>
      {description && <Markdown text={description} />}
      <form onSubmit={constructSubject}>
        {parameters.map(param => {
          return (
            <ResourceField
              key={param}
              propertyURL={param}
              resource={virtualResource}
            />
          );
        })}
      </form>
      <Button onClick={constructSubject}>{isPost ? 'POST' : 'GET'}</Button>

      {hasQueried && results && results.length === 0 && <p>No hits</p>}
      {results.map(result => (
        <ResourceCard key={result} subject={result} />
      ))}
    </ContainerNarrow>
  );
}

export default EndpointPage;
