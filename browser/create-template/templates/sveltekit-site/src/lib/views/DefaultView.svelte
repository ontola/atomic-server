<script lang="ts">
	import type { Resource } from '@tomic/lib';

	interface Props {
		resource: Resource;
	}

	let { resource }: Props = $props();
</script>

<p>No supported view for {resource.title}.</p>
