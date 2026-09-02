<script lang="ts">
	import { core, type Resource } from '@tomic/lib';
	import { Image } from '@tomic/svelte';
	import type { ImageGalleryBlock } from '$lib/ontologies/website';

	interface Props {
		resource: Resource<ImageGalleryBlock>;
	}

	const { resource }: Props = $props();
</script>

{#if resource.props.name}
	<h2>{resource.title}</h2>
{/if}
<div class="wrapper">
	{#each resource.props.images as image}
		<Image subject={image} alt="" />
	{/each}
</div>

<style>
	.wrapper {
		width: 100%;
		display: grid;
		grid-template-columns: repeat(
			auto-fill,
			minmax(calc(var(--theme-size-container-width) / 3 - 4rem), 1fr)
		);
		gap: 1rem;
		:global(& img) {
			aspect-ratio: 1 / 1;
			object-fit: cover;
		}
	}
</style>
