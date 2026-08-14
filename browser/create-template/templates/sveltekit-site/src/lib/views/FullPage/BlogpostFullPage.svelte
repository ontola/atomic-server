<script lang="ts">
	import Container from '$lib/components/Layout/Container.svelte';
	import type { Blogpost } from '$lib/ontologies/website';
	import type { Resource } from '@tomic/lib';
	import { Image } from '@tomic/svelte';
	import SvelteMarkdown from 'svelte-markdown';

	interface Props {
		resource: Resource<Blogpost>;
	}

	const { resource }: Props = $props();

	const formatter = new Intl.DateTimeFormat('default', {
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	});

	let date = $derived(
		resource.props.publishedAt
			? formatter.format(new Date(resource.props.publishedAt))
			: undefined
	);
</script>

<Container>
	<div class="blog-wrapper">
		{#if resource.props.coverImage}
			<Image subject={resource.props.coverImage} alt="" />
		{/if}
		<div class="content">
			<h1>{resource.title}</h1>
			{#if date}
				<p class="publish-date">
					{date}
				</p>
			{/if}
			<SvelteMarkdown source={resource.props.description} />
		</div>
	</div>
</Container>

<style>
	.blog-wrapper {
		padding: 1rem;
		:global(& > picture > img) {
			width: 100%;
			height: 25rem;
			object-fit: cover;
			border-radius: var(--theme-border-radius);
		}
	}

	.publish-date {
		color: var(--theme-color-text-light);
		margin-bottom: 2rem;
	}
	.content {
		max-width: 70ch;
		margin: auto;
	}
</style>
