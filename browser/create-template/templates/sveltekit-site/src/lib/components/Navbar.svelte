<script lang="ts">
	import { PUBLIC_WEBSITE_RESOURCE } from '$env/static/public';
	import { website, type Website } from '$lib/ontologies/website';
	import { getResource } from '@tomic/svelte';
	import MenuItem from '../views/MenuItem/MenuItem.svelte';
	import Container from './Layout/Container.svelte';
	import HStack from './Layout/HStack.svelte';

	let site = getResource<Website>(() => PUBLIC_WEBSITE_RESOURCE);
	let menuItems = $derived(site.props.menuItems ?? []);
</script>

<Container>
	<nav>
		<HStack align="center" justify="space-between" wrap>
			<a class="site-title" href="/">
				{site.title}
			</a>
			<ul>
				{#each menuItems as menuItem (menuItem)}
					<li>
						<MenuItem subject={menuItem} />
					</li>
				{/each}
			</ul>
		</HStack>
	</nav>
</Container>

<style>
	nav {
		gap: 1rem;
		padding: 2rem 1rem;
		border-bottom: 1px solid var(--theme-color-bg-1);
	}

	ul {
		display: flex;
		list-style: none;
		padding: 0;
		margin: 0;
		gap: 1rem;
	}

	.site-title {
		font-size: 1.5rem;
		text-decoration: none;
		color: var(--theme-color-text);
	}
</style>
