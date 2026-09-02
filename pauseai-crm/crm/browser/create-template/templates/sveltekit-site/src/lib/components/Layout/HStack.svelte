<script lang="ts">
	export let gap = '1rem';
	export let align = 'start';
	export let justify = 'start';
	export let fullWidth = false;
	export let wrap = false;
</script>

<div
	style:--hstack-gap={gap}
	style:--hstack-align={align}
	style:--hstack-justify={justify}
	class:full-width={fullWidth}
	class:wrap
>
	<slot />
</div>

<style>
	div {
		display: flex;
		gap: var(--hstack-gap);
		align-items: var(--hstack-align);
		justify-content: var(--hstack-justify);

		:global(& > h1),
		:global(& > h2),
		:global(& > h3),
		:global(& > h4),
		:global(& > h5),
		:global(& > h6) {
			margin: 0;
		}
	}

	.full-width {
		width: 100%;
	}

	.wrap {
		flex-wrap: wrap;
	}
</style>
