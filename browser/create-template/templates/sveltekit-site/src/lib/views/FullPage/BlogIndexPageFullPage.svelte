<script lang="ts">
	import Container from '$lib/components/Layout/Container.svelte';
	import { website, type BlogIndexPage } from '$lib/ontologies/website';
	import { core, type Resource } from '@tomic/lib';
	import ListItemView from '../ListItem/ListItemView.svelte';
	import VStack from '$lib/components/Layout/VStack.svelte';
	import HStack from '$lib/components/Layout/HStack.svelte';
	import Searchbar from '$lib/components/Searchbar.svelte';
	import { throttle } from '$lib/utils';
	import { getAllBlogposts } from '$lib/atomic/getAllBlogposts';
	import { getStoreFromContext } from '@tomic/svelte';

	interface Props {
		resource: Resource<BlogIndexPage>;
	}

	const { resource }: Props = $props();

	const store = getStoreFromContext();

	let allItems = $state<string[]>([]);
	let results = $state<string[]>([]);

	// We create a collection that collects all resources with the blogpost class. Sorted by publishedAt in descending order.
	getAllBlogposts().then((members) => {
		allItems = members;
		results = members;
	});

	const search = throttle(async (searchValue: string) => {
		if (searchValue === '') {
			results = allItems;
			return;
		}

		results = await store.search(searchValue, {
			filters: {
				[core.properties.isA]: website.classes.blogpost
			}
		});
	}, 200);
</script>

<Container>
	<div class="wrapper">
		<VStack>
			<HStack wrap fullWidth align="center" justify="space-between">
				<h1>{resource.title}</h1>
				<Searchbar placeholder="Search blogposts..." oninput={search} />
			</HStack>
			{#if results.length === 0}
				<p>No results found</p>
			{/if}
			<ul>
				{#each results as item (item)}
					<li>
						<ListItemView subject={item} />
					</li>
				{/each}
			</ul>
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
