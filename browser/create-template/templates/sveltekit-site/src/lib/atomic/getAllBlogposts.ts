import { website } from "$lib/ontologies/website";
import { CollectionBuilder, core } from "@tomic/lib";
import { getStore } from "./getStore";
import { PUBLIC_ATOMIC_DRIVE } from "$env/static/public";

export async function getAllBlogposts(): Promise<string[]> {
  const store = getStore();

  const collection = new CollectionBuilder(store)
    .setDrive(PUBLIC_ATOMIC_DRIVE)
    .setProperty(core.properties.isA)
    .setValue(website.classes.blogpost)
    .setSortBy(website.properties.publishedAt)
    .setSortDesc(true)
    .build();

  return collection.getAllMembers();
}
