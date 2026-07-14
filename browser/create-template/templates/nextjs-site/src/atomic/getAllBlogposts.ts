import { website } from '@/ontologies/website';
import { CollectionBuilder, core } from '@tomic/lib';
import { store } from '@/store';
import { env } from '@/env';

export async function getAllBlogposts(): Promise<string[]> {
  const collection = new CollectionBuilder(store)
    .setDrive(env.NEXT_PUBLIC_ATOMIC_DRIVE)
    .setProperty(core.properties.isA)
    .setValue(website.classes.blogpost)
    .setSortBy(website.properties.publishedAt)
    .setSortDesc(true)
    .build();

  return collection.getAllMembers();
}
