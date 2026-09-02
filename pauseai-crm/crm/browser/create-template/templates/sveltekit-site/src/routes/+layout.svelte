<script lang="ts">
	import { createAtomicStoreContext } from '@tomic/svelte';
	import Navbar from '$lib/components/Navbar.svelte';
	import SiteWrapper from '$lib/components/SiteWrapper.svelte';
	import Footer from '$lib/components/Footer.svelte';
	import VStack from '$lib/components/Layout/VStack.svelte';
	import { getStore } from '$lib/atomic/getStore';

	// We set the store on the AtomicStoreContext so it can be accessed by `getResource()`.
	const store = getStore();
	createAtomicStoreContext(store);
</script>

<SiteWrapper>
	<VStack align="stretch" minHeight="100vh">
		<header>
			<Navbar />
		</header>
		<main>
			<slot />
		</main>
		<Footer />
	</VStack>
</SiteWrapper>

<style>
	main {
		flex: 1;
	}
</style>
