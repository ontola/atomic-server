<script lang="ts">
	import { unknownSubject, type Resource } from '@tomic/lib';
	import { type Page, type MenuItem } from '$lib/ontologies/website';
	import { getResource } from '@tomic/svelte';

	interface Props {
		resource: Resource<MenuItem>;
		active: boolean;
	}

	const { resource, active }: Props = $props();

	let page = getResource<Page>(() => resource.props.linksTo);

	// If the menu item has a linksTo prop we want the href value of the page it links to. If that doesn't exist we check for an external link.
	let href = $derived(page.props.href ?? resource.props.externalLink ?? '');
</script>

<a {href} aria-current={active ? 'page' : 'false'}>{resource.title}</a>

<style>
	a {
		width: 100%;
		text-decoration: none;
		color: var(--theme-color-text);
		padding: 0.4rem;
		display: inline-flex;
		border-radius: var(--theme-border-radius);
		transition: background-color 100ms ease-in-out;

		&[aria-current='page'] {
			color: var(--theme-color-accent);
		}

		&:hover,
		&:focus-visible {
			background-color: var(--theme-color-bg-2);
		}
	}
</style>
