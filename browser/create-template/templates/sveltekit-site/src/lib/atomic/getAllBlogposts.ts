import { website } from '$lib/ontologies/website';
import { CollectionBuilder, core } from '@tomic/lib';
import { getStore } from './getStore';
export async function getAllBlogposts(): Promise<string[]> {
	const store = getStore();

	const collection = new CollectionBuilder(store)
		.setProperty(core.properties.isA)
		.setValue(website.classes.blogpost)
		.setSortBy(website.properties.publishedAt)
		.setSortDesc(true)
		.build();

	return collection.getAllMembers();
}
