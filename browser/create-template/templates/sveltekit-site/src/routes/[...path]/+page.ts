import type { PageLoad } from './$types';
import { getCurrentResource } from '$lib/atomic/getCurrentResource';
import { getLanguageAlternates, parseLocalizedPath } from '$lib/atomic/i18n';
import { error } from '@sveltejs/kit';
import { preloadResources } from '$lib/atomic/preloadResources';

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
