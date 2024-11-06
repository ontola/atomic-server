<script lang="ts">
	import { website } from '$lib/ontologies/website';
	import { getResource } from '@tomic/svelte';
	import DefaultView from '../DefaultView.svelte';
	import TextBlock from './TextBlock.svelte';
	import ImageGalleryBlock from './ImageGalleryBlock.svelte';

	interface Props {
		subject: string;
	}

	const { subject }: Props = $props();

	let block = getResource(() => subject);

	let View = $derived(
		block.matchClass(
			{
				[website.classes.textBlock]: TextBlock,
				[website.classes.imageGalleryBlock]: ImageGalleryBlock
			},
			DefaultView
		)
	);
</script>

<View resource={block} />
