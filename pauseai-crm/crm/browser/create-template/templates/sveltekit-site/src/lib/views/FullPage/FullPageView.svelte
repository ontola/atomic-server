<script lang="ts">
	import { website } from '$lib/ontologies/website';
	import { getResource } from '@tomic/svelte';
	import PageFullPage from './PageFullPage.svelte';
	import DefaultFullPage from './DefaultFullPage.svelte';
	import BlogIndexPageFullPage from './BlogIndexPageFullPage.svelte';
	import BlogpostFullPage from './BlogpostFullPage.svelte';

	/*
		Renders a full page view. The actual view component is determined by the resource's class.
	*/

	interface Props {
		subject: string;
	}

	const { subject }: Props = $props();

	let resource = getResource(() => subject);

	let View = $derived(
		resource.matchClass(
			{
				[website.classes.page]: PageFullPage,
				[website.classes.blogIndexPage]: BlogIndexPageFullPage,
				[website.classes.blogpost]: BlogpostFullPage
			},
			DefaultFullPage
		)
	);
</script>

<View {resource} />
