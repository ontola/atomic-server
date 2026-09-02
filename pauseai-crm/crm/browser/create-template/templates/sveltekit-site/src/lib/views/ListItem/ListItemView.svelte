<script lang="ts">
	import { website } from '$lib/ontologies/website';
	import { getResource } from '@tomic/svelte';
	import DefaultView from '../DefaultView.svelte';
	import BlogListItem from './BlogListItem.svelte';

	interface Props {
		subject: string;
	}

	const { subject }: Props = $props();

	let listItem = getResource(() => subject);

	let View = $derived(
		listItem.matchClass(
			{
				[website.classes.blogpost]: BlogListItem
			},
			DefaultView
		)
	);
</script>

<View resource={listItem} />
