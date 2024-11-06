import { website } from '$lib/ontologies/website';
import type { Resource } from '@tomic/lib';
import { getStore } from './getStore';

/**
 * Due to how sveltekit works we sometimes need to preload resources for them to show up in the serverside rendered html.
 * The root resource that is requested is always preloaded but any referenced resources are not.
 * Idially you want to do this for each class that has a full page view.
 * If you do not preload the referenced resources they will not show up when the page is hydrated client side. This should not be a big problem but could cause issues with SEO or users that have javascript disabled.
 */
export async function preloadResources(resource: Resource): Promise<void> {
	const store = getStore();

	if (resource.hasClasses(website.classes.website)) {
		await store.preloadResourceTree(resource.subject, {
			[website.properties.menuItems]: {
				[website.properties.subItems]: true
			}
		});
	}

	if (resource.hasClasses(website.classes.page)) {
		await store.preloadResourceTree(resource.subject, {
			[website.properties.blocks]: {
				[website.properties.images]: true
			}
		});
	}

	if (resource.hasClasses(website.classes.blogpost)) {
		await store.preloadResourceTree(resource.subject, {
			[website.properties.coverImage]: true
		});
	}
}
