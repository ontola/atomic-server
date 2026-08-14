import { CollectionBuilder, core, type Resource } from "@tomic/lib";
import { website } from "$lib/ontologies/website";
import { driveFilter, getStore } from "./getStore";
import { getLanguageConfig } from "./i18n";
import { isListedCmsResource } from "./publicContent";
import { getAllBlogposts } from "./getAllBlogposts";
import { cmsSitemapPaths, type CmsRssItem } from "./feeds";
import {
  PUBLIC_ATOMIC_DRIVE,
  PUBLIC_WEBSITE_RESOURCE,
} from "$env/static/public";

const PAGE_CLASSES = [
  website.classes.page,
  website.classes.blogIndexPage,
  website.classes.blogpost,
];

async function membersOfClass(classUrl: string): Promise<string[]> {
  const store = getStore();

  for (let attempt = 0; ; attempt++) {
    let subjects: string[] = [];

    try {
      const collection = new CollectionBuilder(store)
        .setDrive(PUBLIC_ATOMIC_DRIVE)
        .setProperty(core.properties.isA)
        .setValue(classUrl)
        .addFilter(driveFilter)
        .build();

      subjects = await collection.getAllMembers();
    } catch (_e) {
      // Treated like an empty result: retried below.
    }

    if (subjects.length > 0 || attempt >= 4) {
      return subjects;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Listed pages, blog index, and posts that have a public `href`. */
export async function getListedHrefResources(): Promise<Resource[]> {
  const store = getStore();
  const subjects = (await Promise.all(PAGE_CLASSES.map(membersOfClass))).flat();
  const unique = [...new Set(subjects)];
  const resources = await Promise.all(
    unique.map((subject) =>
      store.fetchResourceFromServer(subject, { noWebSocket: true }),
    ),
  );

  return resources.filter(
    (resource) =>
      isListedCmsResource(resource) &&
      typeof resource.get(website.properties.href) === "string",
  );
}

export async function getSitemapPaths(): Promise<string[]> {
  const { defaultLanguage, languages } = await getLanguageConfig();
  const hrefs = (await getListedHrefResources()).map(
    (resource) => resource.get(website.properties.href) as string,
  );

  return cmsSitemapPaths(hrefs, languages, defaultLanguage);
}

export async function getRssItems(): Promise<{
  title: string;
  items: CmsRssItem[];
}> {
  const store = getStore();
  const site = await store.fetchResourceFromServer(PUBLIC_WEBSITE_RESOURCE, {
    noWebSocket: true,
  });
  const subjects = await getAllBlogposts();
  const items: CmsRssItem[] = [];

  for (const subject of subjects) {
    const resource = await store.getResource(subject);
    const href = resource.get(website.properties.href);

    if (typeof href !== "string") {
      continue;
    }

    const publishedAt = resource.get(website.properties.publishedAt);
    const description = resource.get(core.properties.description);
    const publishedAtNumber = Number(publishedAt);

    items.push({
      title: resource.title,
      path: href,
      description: typeof description === "string" ? description : undefined,
      publishedAt: Number.isFinite(publishedAtNumber)
        ? publishedAtNumber
        : undefined,
    });
  }

  return {
    title: site.error ? "Blog" : site.title,
    items,
  };
}
