import {
  type FetchOpts,
  type OptionalClass,
  proxyResource,
  Resource,
  ResourceEvents,
  unknownSubject,
} from '@tomic/lib';

import { hasContext } from 'svelte';
import { getStoreFromContext } from './store.js';

/**
 * Starts fetching a resource and adds it to the store.
 * An empty resource will be returned immediately that updates when the resource is fetched.
 * This way you can start rendering UI that
 * To check if the resource is ready, use `resource.loading`.
 * Only works in components contexts. If you want to fetch a resource outside of a component, use `await store.getResource()`.
 *
 * You need to pass the subject as a function that returns a string to make it reactive.
 *
 * ## Example
 * ```svelte
 * <script lang="ts">
 *   import { getResource } from '@atomic/svelte';
 *   import { type Comment } from '$lib/ontologies/myApp.js';
 *
 *   const resource = getResource<Comment>(() => 'https://my-atomic-server.com/my-resource');
 * </script>
 *
 * <p>{resource.props.description}</p>
 * ```
 *
 * ## Example with editing
 * ```svelte
 * <script lang="ts">
 *   import { getResource } from '@atomic/svelte';
 *   import { type Comment } from '$lib/ontologies/myApp.js';
 *
 *   const resource = getResource<Comment>(() => 'https://my-atomic-server.com/my-resource');
 * </script>
 *
 * <textarea bind:value={resource.props.description} />
 * <button onclick={() => resource.save()}>Save</button>
 * ```
 */
export function getResource<T extends OptionalClass = never>(
  subjectGetter: () => string | undefined,
  opts?: FetchOpts,
): Resource<T> {
  if (!hasContext('ATOMIC_STORE')) {
    throw new Error('No Atomic Store found in context');
  }

  const subject = $derived(subjectGetter() ?? unknownSubject);

  const store = getStoreFromContext();
  let resource = $state(store.getResourceLoading(subject, opts));

  $effect(() => {
    resource = store.getResourceLoading(subject, opts);
  });

  $effect(() => {
    const unsubLocal = resource.on(ResourceEvents.LocalChange, () => {
      resource = proxyResource(resource.__internalObject);
    });

    const unsubRemote = store.subscribe(subject, r => {
      resource = proxyResource(r);
    });

    return () => {
      unsubLocal();
      unsubRemote();
    };
  });

  return new Proxy(resource, {
    get(_, prop) {
      return resource[prop as keyof Resource];
    },
  });
}
