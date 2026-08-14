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
	import { appState } from '$lib/stores/appstate.svelte';
	import { isListedCmsResource } from '$lib/atomic/publicContent';

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
	// The list is re-fetched when the language of the current page changes.
	const allBlogpostsPromise = $derived(getAllBlogposts(appState.currentLang));

	$effect(() => {
		let cancelled = false;

		allBlogpostsPromise.then((members) => {
			if (cancelled) {
				return;
			}

			allItems = members;

			if (searchValue === '') {
				results = members;
			}
		});

		return () => {
			cancelled = true;
		};
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

			// A transient search failure surfaces as an empty result set, so an
			// empty answer is retried a couple of times before we show "no results".
			let nextResults: string[] = [];

			for (let attempt = 0; attempt < 3; attempt++) {
				nextResults = await store.search(searchValue, {
					parents: blogParent,
					filters: {
						[core.properties.isA]: website.classes.blogpost
					}
				});

				const hits = await Promise.all(
					nextResults.map((subject) => store.getResource(subject))
				);
				nextResults = hits
					.filter(isListedCmsResource)
					.map((hit) => hit.subject);

				if (nextResults.length > 0 || version !== searchVersion) {
					break;
				}

				await new Promise((resolve) => setTimeout(resolve, 400));
			}

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
