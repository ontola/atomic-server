<script lang="ts">
	import type { PageData } from './$types';
	import FullPageView from '$lib/views/FullPage/FullPageView.svelte';
	import { appState } from '$lib/stores/appstate.svelte';

	interface Props {
		data: PageData;
	}

	const { data }: Props = $props();

	appState.currentSubject = data.subject;

	$effect(() => {
		appState.currentSubject = data.subject;
	});
</script>

<FullPageView subject={data.subject} />
