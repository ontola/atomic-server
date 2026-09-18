import type { LayoutServerLoad } from './$types';
import { CMS_CDN_CACHE_CONTROL } from '$lib/atomic/feeds';

export const load: LayoutServerLoad = async ({ setHeaders }) => {
	setHeaders({
		'cache-control': CMS_CDN_CACHE_CONTROL
	});

	return {};
};
