<script lang="ts">
  import { createAtomicStoreContext } from '$lib/stores/store.js';
  import { Store } from '@tomic/lib';

  const { children } = $props();

  // Initialize a store and set it on the context.
  createAtomicStoreContext(
    new Store({
      // A demo drive with some example data.
      serverUrl: 'https://atomicdata.dev/drive/WnY9YDmm',
    }),
  );
</script>

<main>
  {@render children()}
</main>

<style>
  :global(body) {
    font-family: system-ui;
  }

  main {
    width: min(100%, 1000px);
    margin: auto;
    padding-inline: 1rem;
  }
</style>
