import type { PageLoad, EntryGenerator } from './$types';
import { getCurrentResource } from '$lib/atomic/getCurrentResource';
import { getPrerenderPathEntries } from '$lib/atomic/getPublicPages';
import { getLanguageAlternates, parseLocalizedPath } from '$lib/atomic/i18n';
import { error } from '@sveltejs/kit';
import { preloadResources } from '$lib/atomic/preloadResources';

export const prerender = 'auto';

export const entries: EntryGenerator = async () => {
	return await getPrerenderPathEntries();
};

export const load = (async ({ fetch, url }) => {
	const resource = await getCurrentResource(fetch, url);

	if (resource === undefined) {
		error(404, {
			message: 'Page not found'
		});
	}

	await preloadResources(resource);

	const { lang } = await parseLocalizedPath(url.pathname);
	const alternates = await getLanguageAlternates(resource);

	return {
		subject: resource.subject,
		lang,
		alternates
	};
}) satisfies PageLoad;
