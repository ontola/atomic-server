import { website } from '@/ontologies/website';
import { CollectionBuilder, core, i18n, type Resource } from '@tomic/lib';
import { driveFilter, store } from '@/store';
import { env } from '@/env';
import { getLanguageConfig, getResourceLanguage } from './i18n';
import { isListedCmsResource } from './publicContent';

/**
 * All blogposts in the given language, one per translation group.
 * Posts without a version in the language fall back to their canonical version.
 */
export async function getAllBlogposts(lang?: string): Promise<string[]> {
  const subjects = await fetchAllBlogpostSubjects();
  const { defaultLanguage } = await getLanguageConfig();
  const language = lang || defaultLanguage;

  const resources = (
    await Promise.all(subjects.map(subject => store.getResource(subject)))
  ).filter(isListedCmsResource);

  // Group the different translations of a post together.
  // Translations point at their canonical version via `translationOf`.
  const groups = new Map<string, Resource[]>();

  for (const resource of resources) {
    const canonical =
      resource.get(i18n.properties.translationOf) ?? resource.subject;
    groups.set(canonical, [...(groups.get(canonical) ?? []), resource]);
  }

  // Pick one version per post: the requested language when available,
  // otherwise the canonical version.
  return Array.from(groups.values(), versions => {
    const pick =
      versions.find(
        version => getResourceLanguage(version, defaultLanguage) === language,
      ) ??
      versions.find(
        version => version.get(i18n.properties.translationOf) === undefined,
      ) ??
      versions[0];

    return pick.subject;
  });
}

/**
 * The store reports a failed collection query as an empty page (transient
 * server errors are swallowed), so an empty result is retried a few times
 * before we trust it — this site always has blogposts.
 */
async function fetchAllBlogpostSubjects(): Promise<string[]> {
  for (let attempt = 0; ; attempt++) {
    let subjects: string[] = [];

    try {
      const collection = new CollectionBuilder(store)
        .setDrive(env.NEXT_PUBLIC_ATOMIC_DRIVE)
        .setProperty(core.properties.isA)
        .setValue(website.classes.blogpost)
        .addFilter(driveFilter)
        .setSortBy(website.properties.publishedAt)
        .setSortDesc(true)
        .build();

      subjects = await collection.getAllMembers();
    } catch (_e) {
      // Treated like an empty result: retried below.
    }

    if (subjects.length > 0 || attempt >= 4) {
      return subjects;
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
