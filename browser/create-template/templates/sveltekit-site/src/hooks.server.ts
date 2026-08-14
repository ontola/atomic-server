import type { Handle } from '@sveltejs/kit';
import { getLanguageConfig } from '$lib/atomic/i18n';
import { CMS_CDN_CACHE_CONTROL } from '$lib/atomic/feeds';

function isPublicCacheable(pathname: string, contentType: string | null): boolean {
	if (pathname.startsWith('/_app/') || pathname.startsWith('/s/')) {
		return false;
	}

	const type = contentType ?? '';

	return (
		type.includes('text/html') ||
		type.includes('xml') ||
		pathname === '/robots.txt' ||
		pathname.endsWith('.xml')
	);
}

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

	const response = await resolve(event, {
		filterSerializedResponseHeaders: (name) => name === 'x-atomic-server-version',
		transformPageChunk: ({ html }) => html.replace('%lang%', lang)
	});

	if (
		event.request.method === 'GET' &&
		response.ok &&
		isPublicCacheable(event.url.pathname, response.headers.get('content-type'))
	) {
		response.headers.set('Cache-Control', CMS_CDN_CACHE_CONTROL);
	}

	return response;
};
