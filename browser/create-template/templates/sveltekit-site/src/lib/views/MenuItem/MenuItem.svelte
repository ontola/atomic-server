<script lang="ts">
	import { type MenuItem } from '$lib/ontologies/website';
	import { generateId } from '$lib/utils';
	import { getResource } from '@tomic/svelte';
	import MenuItemLink from './MenuItemLink.svelte';
	import type { FocusEventHandler } from 'svelte/elements';
	import { appState } from '$lib/stores/appstate.svelte';
	import Self from './MenuItem.svelte';
	/*
		This view renders a menu-item resource. A menu-item can have a linked-to property but also a sub-items property.
		If it has a links-to prop, we simply render a link that navigates to the href of the linked resource.
		If it has a sub-items prop, we render a button that toggles a popover in which we render this same view for all sub items.
	*/

	interface Props {
		subject: string;
	}

	const { subject }: Props = $props();

	/* A random id used to link the button to the popover */
	const id = generateId();
	const anchorName = `--menuItem-${id}`;

	let menuItem = getResource<MenuItem>(() => subject);
	let subItems = $derived(menuItem.props.subItems);

	let popover: HTMLDivElement | undefined = $state();
	let button: HTMLButtonElement | undefined = $state();

	let submenuPosition = $state({
		top: '0px',
		left: '0px'
	});

	const closePopover = () => {
		popover?.hidePopover();
	};

	// When the popover loses focus we check if that focus moved outside of the popover or the button that toggles it.
	// If so we close the popover.
	const onFocusout: FocusEventHandler<HTMLButtonElement | HTMLDivElement> = (event) => {
		if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget as Node)) {
			closePopover();
		}
	};

	let calcPopoverPosition = () => {
		if (!button || !popover) return;

		// Check if the anchor position api is supported. If so we don't need to calculate the position.
		if (CSS.supports('anchor-name', '--something')) {
			return;
		}

		const rect = button.getBoundingClientRect();

		submenuPosition.top = `calc(${rect.top}px + 2rem)`;
		submenuPosition.left = `calc(${rect.left}px - (var(--menu-width) / 2 - ${rect.width / 2}px))`;
	};
</script>

<svelte:document
	on:click={(e) => {
		if (!button?.contains(e.currentTarget) && !popover?.contains(e.currentTarget)) {
			closePopover();
		}
	}}
/>
{#if subItems && subItems.length > 0}
	<button
		bind:this={button}
		popovertarget={id}
		popovertargetaction="toggle"
		onclick={calcPopoverPosition}
		style:--anchor-name={anchorName}
	>
		{menuItem.title}
	</button>

	<div
		class="submenu"
		popover="manual"
		{id}
		bind:this={popover}
		onfocusout={onFocusout}
		style:--top={submenuPosition.top}
		style:--left={submenuPosition.left}
		style:--anchor-name={anchorName}
	>
		{#each subItems as subItem}
			<ul>
				<li>
					<Self subject={subItem} />
				</li>
			</ul>
		{/each}
	</div>
{:else}
	<!-- The resource does not have subitems so we just render a link -->
	<MenuItemLink resource={menuItem} active={appState.currentSubject === menuItem.props.linksTo} />
{/if}

<style>
	ul {
		padding: 0.5rem;
		list-style: none;
	}

	button {
		anchor-name: var(--anchor-name);
		padding: 0.4rem;
		display: inline-flex;
		align-items: center;
		border-radius: var(--theme-border-radius);
		height: 100%;
		appearance: none;
		border: none;
		background: none;
		cursor: pointer;
		transition: background-color 100ms ease-in-out;
		&:hover,
		&:focus-visible {
			background-color: var(--theme-color-bg-2);
		}
	}

	.submenu {
		--menu-width: 20ch;
		width: var(--menu-width);
		border: 1px solid var(--theme-color-bg-1);
		border-radius: var(--theme-border-radius);
		box-shadow:
			0px 2.8px 2.2px rgba(0, 0, 0, 0.02),
			0px 6.7px 5.3px rgba(0, 0, 0, 0.028),
			0px 12.5px 10px rgba(0, 0, 0, 0.035),
			0px 22.3px 17.9px rgba(0, 0, 0, 0.042),
			0px 41.8px 33.4px rgba(0, 0, 0, 0.05),
			0px 100px 80px rgba(0, 0, 0, 0.07);

		position-anchor: var(--anchor-name);
		position-area: bottom center;

		@supports not (anchor-name: --something) {
			position: fixed;
			top: var(--top);
			left: var(--left);
		}
	}
</style>
