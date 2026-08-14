<script lang="ts">
	import Container from '$lib/components/Layout/Container.svelte';
	import type { BlogIndexPage } from '$lib/ontologies/website';
	import { type Resource } from '@tomic/lib';
	import ListItemView from '../ListItem/ListItemView.svelte';
	import VStack from '$lib/components/Layout/VStack.svelte';
	import HStack from '$lib/components/Layout/HStack.svelte';
	import Searchbar from '$lib/components/Searchbar.svelte';
	import { getAllBlogposts } from '$lib/atomic/getAllBlogposts';
	import { getStoreFromContext } from '@tomic/svelte';

	interface Props {
		resource: Resource<BlogIndexPage>;
		lang?: string;
	}

	const { resource, lang }: Props = $props();

	const store = getStoreFromContext();

	let searchValue = $state('');
	let needle = $derived(searchValue.trim().toLowerCase());

	async function postsForLang(language: string | undefined) {
		const subjects = await getAllBlogposts(language);

		return Promise.all(
			subjects.map(async (subject) => {
				const post = await store.getResource(subject);

				return { subject, title: post.title ?? '' };
			})
		);
	}

	let postsPromise = $derived(postsForLang(lang));
</script>

<Container>
	<div class="wrapper">
		<VStack>
			<HStack wrap fullWidth align="center" justify="space-between">
				<h1>{resource.title}</h1>
				<Searchbar placeholder="Search blogposts..." bind:value={searchValue} />
			</HStack>
			{#await postsPromise}
				<p>Loading…</p>
			{:then posts}
				{@const visible = needle
					? posts.filter((post) => post.title.toLowerCase().includes(needle))
					: posts}
				{#if visible.length === 0}
					<p>No results found</p>
				{/if}
				<ul>
					{#each visible as item (item.subject)}
						<li>
							<ListItemView subject={item.subject} />
						</li>
					{/each}
				</ul>
			{/await}
		</VStack>
	</div>
</Container>

<style>
	.wrapper {
		padding: 1rem;
	}

	ul {
		display: grid;
		grid-template-columns: repeat(
			auto-fill,
			minmax(calc(var(--theme-size-container-width) / 3 - 4rem), 1fr)
		);
		gap: 1rem;
		list-style-type: none;
		padding: 0;
	}
</style>
