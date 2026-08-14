import { CollectionBuilder, type Resource } from "@tomic/lib";
import { driveFilter, getStore } from "./getStore";
import { findTranslation, parseLocalizedPath } from "./i18n";
import { isListedCmsResource } from "./publicContent";
import { website } from "$lib/ontologies/website";
import {
  PUBLIC_ATOMIC_DRIVE,
  PUBLIC_WEBSITE_RESOURCE,
} from "$env/static/public";

type Fetch = typeof fetch;

/** The Website resource's `homepage` is what `/` (and `/nl`) serve. */
async function getWebsiteHomepage(): Promise<Resource | undefined> {
  const store = getStore();
  const site = await store.getResource(PUBLIC_WEBSITE_RESOURCE);

  if (site.error) {
    return undefined;
  }

  const homepageSubject = site.get(website.properties.homepage);

  if (typeof homepageSubject !== "string") {
    return undefined;
  }

  const homepage = await store.getResource(homepageSubject);

  return isListedCmsResource(homepage) ? homepage : undefined;
}

/**
 * Queries the server for a resource with a href property that matches the given url pathname.
 * @param fetchOverride A fetch function given by Sveltekit.
 * @param url The current URL in the browser.
 * @returns Promise that resolves to the subject of the resource, or undefined if no resource was found.
 */
export async function getCurrentResource(
  fetchOverride: Fetch,
  url: URL,
): Promise<Resource | undefined> {
  const store = getStore();
  // Svelte uses a special fetch function that inlines responses during server-side rendering.
  // To make sure the store can make use of this we need to inject the fetch function into the store.
  store.injectFetch(fetchOverride);

  // The path may start with a language prefix, e.g. /nl/blog/some-post.
  const { lang, path, prefixed } = await parseLocalizedPath(url.pathname);

  if (path === "/" || path === "") {
    const homepage = await getWebsiteHomepage();

    if (homepage) {
      return prefixed ? findTranslation(homepage, lang) : homepage;
    }
  }

  // Find the resource with the current path as href.
  const collection = await new CollectionBuilder(store)
    .setDrive(PUBLIC_ATOMIC_DRIVE)
    .setProperty(website.properties.href)
    .setValue(path)
    .addFilter(driveFilter)
    .buildAndFetch();

  if (collection.totalMembers === 0) {
    return undefined;
  }

  const subjects = await collection.getAllMembers();
  const candidates = (
    await Promise.all(subjects.map((subject) => store.getResource(subject)))
  ).filter(isListedCmsResource);

  if (candidates.length === 0) {
    return undefined;
  }

  const resource = candidates[0];

  if (!prefixed) {
    // Without an explicit language in the URL, the resource's own href wins:
    // every translation is reachable through its own path.
    return resource;
  }

  // When the resource is not in the explicitly requested language, prefer a
  // translation that is.
  return await findTranslation(resource, lang);
}
