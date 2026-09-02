import { PUBLIC_WEBSITE_RESOURCE } from '$env/static/public';
import { getStore } from '$lib/atomic/getStore';
import { preloadResources } from '$lib/atomic/preloadResources';

// This can be false if you're using a fallback (i.e. SPA mode)
export const prerender = false;

export const load = async ({ fetch }) => {
	const store = getStore();
	store.injectFetch(fetch);

	const site = await store.getResource(PUBLIC_WEBSITE_RESOURCE);
	await preloadResources(site);
};
