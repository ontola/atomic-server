import { website } from '@/ontologies/website';
import { CollectionBuilder, core } from '@tomic/lib';
import { store } from '@/store';

export async function getAllBlogposts(): Promise<string[]> {
  const collection = new CollectionBuilder(store)
    .setProperty(core.properties.isA)
    .setValue(website.classes.blogpost)
    .setSortBy(website.properties.publishedAt)
    .setSortDesc(true)
    .build();

  return collection.getAllMembers();
}
