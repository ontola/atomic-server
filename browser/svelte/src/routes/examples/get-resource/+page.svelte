<script lang="ts">
  import { getResource } from '$lib/stores/getResource.svelte.js';
  import { type DataBrowser } from '@tomic/lib';
  let subject = $state('https://atomicdata.dev/01jaz86dd6q7kp2qv7pr23n9cb');
  let resource = getResource<DataBrowser.Folder>(() => subject);
</script>

<div>
  <h1>{resource.props.name}</h1>
  <label for="name">
    Edit name:
    <input type="text" bind:value={resource.props.name} />
  </label>
  <label>
    Subject:
    <input type="text" bind:value={subject} />
  </label>
</div>
