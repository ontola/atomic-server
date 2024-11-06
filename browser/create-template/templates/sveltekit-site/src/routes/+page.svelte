<script lang="ts">
	import type { PageData } from './$types';
	import FullPageView from '$lib/views/FullPage/FullPageView.svelte';
	import { appState } from '$lib/stores/appstate.svelte';

	/*
		This website only has 2 routes that are basically the same, the main difference is that svelte needs one specifically for the root path and then another one for all other paths.

		The page data is fetched by `+page.ts` and the resource's subject is passed in the data prop.
		We pass this subject to the FullPageView View that then determines what kind of view to render.
	*/

	interface Props {
		data: PageData;
	}

	const { data }: Props = $props();

	let { subject } = data;

	appState.currentSubject = subject;
</script>

<FullPageView {subject} />
