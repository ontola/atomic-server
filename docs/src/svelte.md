{{#title @tomic/svelte: Using Atomic Data in a Svelte or SvelteKit project}}

# @tomic/svelte

An AtomicServer client for [Svelte](https://svelte.dev/).
Makes fetching AtomicData easy.
Fetched resources are chached and reactive, they will update when the data changes, even when the resource was changed by someone else.

[See open source template: `atomic-sveltekit-demo` (outdated).](https://github.com/atomicdata-dev/atomic-sveltekit-demo)

## Quick Examples

### Getting a resource and displaying one of its properties

```html
<script lang="ts">
  import { getResource } from '@tomic/svelte';
  import { type Core } from '@tomic/lib';

  const resource = getResource<Core.Agent>(() => 'https://example.com/user1');
</script>

<h1>{resource.props.name}</h1>
```

### Changing the value of a property with an input field

```html
<script lang="ts">
  import { getResource } from '@tomic/svelte';
  import { type Core } from '@tomic/lib';

  const resource = getResource<Core.Agent>(() => 'https://example.com/user1');
</script>

<input bind:value={resource.props.name} />
<button onclick={() => resource.save()}>Save</button>
```

## Getting started

Install the library with your preferred package manager:

```bash
npm install -S @tomic/svelte @tomic/lib
```

```bash
yarn add @tomic/svelte @tomic/lib
```

```bash
pnpm add @tomic/svelte @tomic/lib
```

### Creating a store

@tomic/svelte uses svelte's context API to make the store available to any sub components.
The store is what fetches and caches resources.
It also handles authentication by setting an agent, therefore you should always create a separate store on authenticated routes.

To initialise the store, create a new store and then call `createAtomicStoreContext` with the store as the argument:

```html
// App.svelte or +page.svelte

<script lang="ts">
  import { createAtomicStoreContext } from '@tomic/svelte';
  import { Store } from '@tomic/lib';

  const store = new Store();

  createAtomicStoreContext(store);
</script>

// do svelty things
```

You can now access this store from any sub component by using `getStoreFromContext()`.

```html
// Some random component.svelte

<script lang="ts">
  import { getStoreFromContext } from '@tomic/svelte';
  import { dataBrowser } from '@tomic/lib';

  const store = getStoreFromContext();
  store.newResource({
    isA: [dataBrowser.classes.Folder]
    parant: 'some_other_subject',
  });
</script>
```

If you've used @tomic/lib before you might know that fetching resources is done with `await store.getResource()`.
However, this is not very practical in Svelte because it's async and not reactive, meaning it won't update when its data changes.
That's where the `getResource` function comes in.

`getResource` returns a reactive resource object.
At first the resource will be empty and its loading property will be true (unless it was found in the cache).
The store will start fetching and will update the resource instance when it's done.

```html
// Some random component.svelte

<script lang="ts">
  import { getResource, getValue } from '@tomic/svelte';
  import { type Page } from '$lib/ontologies/myApp.js';

  const page = getResource<Page>(() => 'https://example.com/');
</script>

<main>
  {#if page.loading}
    <p>Loading...</p>
  {:else}
    <h1>{page.title}</h1>
    <p>{page.props.description}</p>
  {/if}
</main>
```

To write data to a resource, just change the value of its properties and save it when you're done.
*Note: you can only write to resources when you've set an agent on the store.*

```js
page.props.name = 'New Title';
page.save();
```

## Typescript

This library is build using typescript and is fully typed. To take full advantage of Atomic Data's strong type system use [@tomic/cli](https://www.npmjs.com/package/@tomic/cli) to generate types using Ontologies. These can then be used like this:

```html
<script lang="ts">
  import { getResource, getValue } from '@tomic/svelte';
  import { core } from '@tomic/lib';
  // User 'app' ontology generated using @tomic/cli
  import { type Person, app } from './ontologies';

  const resource = getResource<Person>(() =>'https://myapp.com/users/me'); // Readable<Resource<Person>>
  const name = $derived(resource.props.name); // string
  const hobbies = $derived(resource.props.hobbies); // string[] - a list of subjects of 'Hobby' resources.
</script>
```

## Using with SvelteKit

While this library is mostly focussed on client side rendering it can also be used on the server.
There are a few important things to keep in mind to avoid problems with server side rendering.

### The problem with fetching inside components

When SvelteKit renders a page on the server it will only do so once and it won't wait for any pending requests.
Because `getResource` is async only the empty resource it initially returns is sent to the client.
It is still fetched and rendered after the page hydrates but the user might see a flicker of missing content.
This essentially means you won't get much benefit out of rendering on the server.

There are a few ways to mitigate this.

#### Load Functions

One option is to just not use `getResource`, or `@tomic/svelte` for that matter, and only use `@tomic/lib` to fetch resources in a load function with `await store.getResource()`.
This isn't a big deal if you only need a single resource with a little bit of data but depending on how dynamic your site is this might become cumbersome.

#### Preloading resources

Another option is to preload the resources you need for a page.
Inside the load function of your route you can call `await store.preloadResourceTree()` to fetch the resource and any referenced resources.
When the resources have been preloaded they are available in the store's cache so you can use `getResource` in your components as usual.
More info about the `preloadResourceTree` function can be found [here](./js-lib/store.md).

```js
export async function load({ params }) {
  const store = getStoreFromSomewhere();

  await store.preloadResourceTree('https://myapp.com/my-page', {
   [website.properties.blocks]: {
    [website.properties.images]: true
   }
  });
}
```

### SvelteKits custom `fetch` function

SvelteKit has a clever custom fetch function that caches a response and inlines it in the pages HTML so the client doesn't have to send the request again.
You need to inject this fetch function into the store so it can be used for fetching resources.

```js
// some +page.js
export async function load({ fetch }) {
  const store = getStoreFromSomewhere();
  store.injectFetch(fetch);
}
```
