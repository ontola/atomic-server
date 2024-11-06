<script lang="ts">
	import FaMagnifyingGlass from './Icons/FaMagnifyingGlass.svelte';
	import HStack from './Layout/HStack.svelte';

	interface Props {
		value?: string;
		placeholder: string;
		oninput: (value: string) => void;
	}

	let { value = $bindable(''), placeholder, oninput }: Props = $props();
</script>

<div class="search-bar">
	<HStack align="center" gap="1ch">
		<FaMagnifyingGlass />
		<input
			type="search"
			bind:value
			{placeholder}
			oninput={(e) => oninput(e.currentTarget.value ?? '')}
		/>
	</HStack>
</div>

<style>
	.search-bar {
		border: 1px solid var(--theme-color-bg-1);
		border-radius: 10rem;
		padding-inline: 1rem;

		&:focus-within {
			box-shadow: 0px 0px 0px 2px var(--theme-color-accent);
		}
		:global(& svg) {
			width: 1rem;
			fill: var(--theme-color-text-light);
		}
	}

	input {
		height: 2rem;
		appearance: none;
		border: none;
		outline: none;
		background: none;
		background-color: transparent;
	}
</style>
