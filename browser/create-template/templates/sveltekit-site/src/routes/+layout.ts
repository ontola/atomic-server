import { PUBLIC_WEBSITE_RESOURCE } from '$env/static/public';
import { getStore } from '$lib/atomic/getStore';
import { getLanguageConfig } from '$lib/atomic/i18n';
import { preloadResources } from '$lib/atomic/preloadResources';

// Known pages are prerendered at build (see `[...path]` `entries()`). New
// paths after publish still SSR on demand; Cache-Control in hooks.server.ts
// is what a CDN honours.
export const prerender = 'auto';

export const load = async ({ fetch }) => {
	const store = getStore();
	store.injectFetch(fetch);

	const site = await store.getResource(PUBLIC_WEBSITE_RESOURCE);
	await preloadResources(site);

	return {
		languageConfig: await getLanguageConfig()
	};
};
