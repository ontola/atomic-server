<script lang="ts">
	import Container from '$lib/components/Layout/Container.svelte';
	import { website, type BlogIndexPage } from '$lib/ontologies/website';
	import { core, type Resource } from '@tomic/lib';
	import ListItemView from '../ListItem/ListItemView.svelte';
	import VStack from '$lib/components/Layout/VStack.svelte';
	import HStack from '$lib/components/Layout/HStack.svelte';
	import Searchbar from '$lib/components/Searchbar.svelte';
	import { getAllBlogposts } from '$lib/atomic/getAllBlogposts';
	import { getStoreFromContext } from '@tomic/svelte';
	import { PUBLIC_ATOMIC_DRIVE } from '$env/static/public';

	interface Props {
		resource: Resource<BlogIndexPage>;
	}

	const { resource }: Props = $props();

	const store = getStoreFromContext();

	let allItems = $state<string[]>([]);
	let results = $state<string[]>([]);
	let searchValue = $state('');
	let searchTimeout: ReturnType<typeof setTimeout>;
	let searchVersion = 0;

	// We create a collection that collects all resources with the blogpost class. Sorted by publishedAt in descending order.
	const allBlogpostsPromise = getAllBlogposts();

	allBlogpostsPromise.then((members) => {
		allItems = members;

		if (searchValue === '') {
			results = members;
		}
	});

	$effect(() => {
		clearTimeout(searchTimeout);
		const version = ++searchVersion;

		if (searchValue === '') {
			results = allItems;

			return;
		}

		searchTimeout = setTimeout(async () => {
			const blogposts = await allBlogpostsPromise;
			const firstBlogpost = blogposts[0]
				? await store.getResource(blogposts[0])
				: undefined;
			const blogParent =
				(firstBlogpost?.get(core.properties.parent) as string | undefined) ??
				PUBLIC_ATOMIC_DRIVE;
			const nextResults = await store.search(searchValue, {
				parents: blogParent,
				filters: {
					[core.properties.isA]: website.classes.blogpost
				}
			});

			if (version === searchVersion) {
				results = nextResults;
			}
		}, 200);
	});
</script>

<Container>
	<div class="wrapper">
		<VStack>
			<HStack wrap fullWidth align="center" justify="space-between">
				<h1>{resource.title}</h1>
				<Searchbar placeholder="Search blogposts..." bind:value={searchValue} />
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
