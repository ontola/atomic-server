<script lang="ts">
	import type { PageData } from './$types';
	import FullPageView from '$lib/views/FullPage/FullPageView.svelte';
	import { appState } from '$lib/stores/appstate.svelte';

	interface Props {
		data: PageData;
	}

	const { data }: Props = $props();

	appState.currentSubject = data.subject;
	appState.currentLang = data.lang;

	$effect(() => {
		appState.currentSubject = data.subject;
		appState.currentLang = data.lang;
		// Keep the <html lang> attribute in sync during client-side navigation.
		document.documentElement.lang = data.lang;
	});
</script>

<svelte:head>
	{#each data.alternates as alternate (alternate.lang)}
		<link rel="alternate" hreflang={alternate.lang} href={alternate.href} />
	{/each}
</svelte:head>

<FullPageView subject={data.subject} />
