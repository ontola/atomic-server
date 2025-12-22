import {
  type FetchOpts,
  type OptionalClass,
  Resource,
  unknownSubject,
} from '@tomic/lib';

import { hasContext } from 'svelte';
import { getStoreFromContext } from './store.js';

/**
 * Starts fetching a resource and adds it to the store.
 * Unless the resource was found in the cache, an empty resource will be returned immediately that updates when the resource is fetched.
 * This way you can start rendering UI without having to wait for the resource to be fetched.
 * To check if the resource is ready, use `resource.loading`.
 * Only works in component contexts. If you want to fetch a resource outside of a component, use `await store.getResource()`.
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

  // One state cell per call. `store.subscribe` fires for every resource
  // change (local edits + WS pushes); we re-read the snapshot on each
  // event, and Svelte's reactivity follows the `.resource` re-assignment.
  let snap = $state(store.getResourceSnapshot(subject, opts));

  $effect(() =>
    store.subscribe(subject, () => {
      snap = store.getResourceSnapshot(subject, opts);
    }),
  );

  // The outer Proxy delegates property reads to the latest snapshot, so
  // template expressions like `resource.props.x` stay reactive across
  // snapshot replacements.
  return new Proxy({} as Resource, {
    get(_, prop) {
      return snap.resource[prop as keyof Resource];
    },
  }) as Resource<T>;
}
