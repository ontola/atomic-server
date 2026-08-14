import { PUBLIC_WEBSITE_RESOURCE } from '$env/static/public';
import { getStore } from '$lib/atomic/getStore';
import { getLanguageConfig } from '$lib/atomic/i18n';
import { preloadResources } from '$lib/atomic/preloadResources';

// Pages are SSR'd with Cache-Control (see hooks.server.ts / +layout.server.ts)
// so a CDN can cache the first-byte HTML. Prerendered files are served by
// sirv and would drop those headers.
export const prerender = false;

export const load = async ({ fetch }) => {
	const store = getStore();
	store.injectFetch(fetch);

	const site = await store.getResource(PUBLIC_WEBSITE_RESOURCE);
	await preloadResources(site);

	return {
		languageConfig: await getLanguageConfig()
	};
};
