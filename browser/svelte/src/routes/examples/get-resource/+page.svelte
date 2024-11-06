<script lang="ts">
  import { getResource } from '$lib/stores/getResource.svelte.js';
  import { type DataBrowser } from '@tomic/lib';

  let resource = getResource<DataBrowser.Folder>(
    () => 'https://atomicdata.dev/01jaz86dd6q7kp2qv7pr23n9cb',
  );
</script>

<div>
  <h1>{resource.title}</h1>
</div>
