<script lang="ts">
	import Container from './Layout/Container.svelte';
	import { appState } from '$lib/stores/appstate.svelte';
	import { getLanguageLinks, type LanguageLink } from '$lib/atomic/i18n';

	const year = new Date().getFullYear();

	let links = $state<LanguageLink[]>([]);

	// Build links to the current page in each of the website's languages.
	$effect(() => {
		const subject = appState.currentSubject;
		let cancelled = false;

		getLanguageLinks(subject).then((languageLinks) => {
			if (!cancelled) {
				links = languageLinks;
			}
		});

		return () => {
			cancelled = true;
		};
	});
</script>

<footer>
	<Container>
		<div class="row">
			<p>© {year} Your Company</p>
			{#if links.length > 1}
				<ul>
					{#each links as link (link.lang)}
						<li>
							<a href={link.href} hreflang={link.lang}>{link.lang}</a>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</Container>
</footer>

<style>
	footer {
		background-color: var(--theme-color-bg-2);
		color: var(--theme-color-text-light);
	}

	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
	}

	p {
		padding: 1rem;
	}

	ul {
		display: flex;
		gap: 0.5rem;
		list-style: none;
		padding: 1rem;
		margin: 0;
		text-transform: uppercase;
	}

	a {
		color: inherit;
	}
</style>
