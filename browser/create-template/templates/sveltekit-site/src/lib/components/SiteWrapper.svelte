<script lang="ts">
	import { core } from '@tomic/lib';
	import { getResource } from '@tomic/svelte';
	import { appState } from '$lib/stores/appstate.svelte';
	import { cmsEditUrl } from '$lib/atomic/cmsEditUrl';
	import { PUBLIC_ATOMIC_CMS_URL } from '$env/static/public';
	import { onMount } from 'svelte';
	import '../../styles/reset.css';

	let page = getResource(() => appState.currentSubject);

	function isTypingTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) {
			return false;
		}

		if (target.isContentEditable) {
			return true;
		}

		const tag = target.tagName;

		return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
	}

	function onKeyDown(event: KeyboardEvent) {
		if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'e') {
			return;
		}

		if (event.altKey || event.shiftKey || isTypingTarget(event.target)) {
			return;
		}

		if (!appState.currentSubject) {
			return;
		}

		event.preventDefault();
		window.open(
			cmsEditUrl(PUBLIC_ATOMIC_CMS_URL, appState.currentSubject),
			'_blank',
			'noopener,noreferrer'
		);
	}

	onMount(() => {
		window.addEventListener('keydown', onKeyDown);

		return () => window.removeEventListener('keydown', onKeyDown);
	});
</script>

<svelte:head>
	<title>{page.title}</title>
	<meta content={page.get(core.properties.description)} name="description" />
	<link rel="alternate" type="application/rss+xml" title="RSS" href="/rss.xml" />
</svelte:head>
<slot />

<style>
	:root {
		--theme-color-bg: #fff;
		--theme-color-bg-1: #e3e3e3;
		--theme-color-bg-2: #ededed;
		--theme-color-accent: hsl(179, 58%, 32%);
		--theme-color-alert: hsl(356, 53%, 50%);
		--theme-color-text: #000;
		--theme-color-text-light: #555555;
		--theme-size-container-width: 900px;
		--theme-border-radius: 5px;
	}

	:global(body) {
		font-family: system-ui;
		background-color: var(--theme-color-bg);
		color: var(--theme-color-text);
		margin: 0px;
		min-height: 100vh;
	}

	:global([popover]) {
		margin: 0;
		padding: 0;
	}
</style>
