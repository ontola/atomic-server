<script lang="ts">
	import Container from '$lib/components/Layout/Container.svelte';
	import type { Resource } from '@tomic/lib';

	interface Props {
		resource: Resource;
	}

	const { resource }: Props = $props();
</script>

<Container>
	<h1>{resource.title}</h1>

	<p>No valid page view for this resource.</p>
</Container>
