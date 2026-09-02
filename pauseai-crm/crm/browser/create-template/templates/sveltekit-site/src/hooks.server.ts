import type { Handle } from '@sveltejs/kit';
import { getLanguageConfig } from '$lib/atomic/i18n';

export const handle: Handle = async ({ event, resolve }) => {
	// Derive the language of the request from the URL's first path segment,
	// so the %lang% placeholder in app.html can be filled in per request.
	let lang = 'en';

	try {
		const { defaultLanguage, languages } = await getLanguageConfig();
		const [first] = event.url.pathname.split('/').filter(Boolean);
		lang = first && languages.includes(first) ? first : defaultLanguage;
	} catch {
		// Keep the fallback language when the website resource cannot be fetched.
	}

	return resolve(event, {
		filterSerializedResponseHeaders: (name) => name === 'x-atomic-server-version',
		transformPageChunk: ({ html }) => html.replace('%lang%', lang)
	});
};
