<script lang="ts">
	import Container from './Layout/Container.svelte';
	import { appState } from '$lib/stores/appstate.svelte';
	import { getLanguageLinks, type LanguageLink } from '$lib/atomic/i18n';
	import { cmsEditUrl } from '$lib/atomic/cmsEditUrl';
	import { PUBLIC_ATOMIC_CMS_URL } from '$env/static/public';

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
			<div class="links">
				{#if appState.currentSubject}
					<a href="/rss.xml">RSS</a>
					<a
						data-testid="cms-edit-link"
						href={cmsEditUrl(PUBLIC_ATOMIC_CMS_URL, appState.currentSubject)}
						rel="noreferrer"
						target="_blank">Edit this page</a
					>
				{/if}
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

	.links {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
	}

	.links > a {
		padding: 1rem;
		text-underline-offset: 0.2em;
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
