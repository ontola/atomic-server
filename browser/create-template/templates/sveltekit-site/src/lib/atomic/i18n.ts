import { CollectionBuilder, i18n, type Resource } from "@tomic/lib";
import { driveFilter, getStore } from "./getStore";
import { website } from "$lib/ontologies/website";
import {
  PUBLIC_ATOMIC_DRIVE,
  PUBLIC_WEBSITE_RESOURCE,
} from "$env/static/public";

/** Used when the website resource does not declare a default language. */
const FALLBACK_LANGUAGE = "en";

export interface LanguageConfig {
  /** Language of resources that have no explicit `language` property. */
  defaultLanguage: string;
  /** All languages the website declares content for. */
  languages: string[];
}

export interface LanguageLink {
  lang: string;
  href: string;
}

let languageConfigPromise: Promise<LanguageConfig> | undefined;

/**
 * Reads the language configuration from the website resource.
 * The result is cached: it is read once per server process / browser session.
 */
export function getLanguageConfig(): Promise<LanguageConfig> {
  languageConfigPromise ??= fetchLanguageConfig().catch(() => {
    // Don't cache failures, and fall back to a sensible default.
    languageConfigPromise = undefined;

    return {
      defaultLanguage: FALLBACK_LANGUAGE,
      languages: [FALLBACK_LANGUAGE],
    };
  });

  return languageConfigPromise;
}

async function fetchLanguageConfig(): Promise<LanguageConfig> {
  const store = getStore();
  const site = await store.fetchResourceFromServer(PUBLIC_WEBSITE_RESOURCE, {
    noWebSocket: true,
  });

  if (site.error) {
    // Drop the errored resource so later reads fetch it again instead of
    // waiting for it to become ready.
    store.removeResource(site.subject);

    throw site.error;
  }

  const defaultLanguage =
    site.get(i18n.properties.defaultLanguage) ?? FALLBACK_LANGUAGE;

  // `languages` is a JSON array. Older sites may not have it at all.
  const declared = site.get(i18n.properties.languages);
  const languages = Array.isArray(declared)
    ? declared.filter((lang): lang is string => typeof lang === "string")
    : [];

  return {
    defaultLanguage,
    languages: languages.length > 0 ? languages : [defaultLanguage],
  };
}

/**
 * Splits a URL pathname into the requested language and the remaining path.
 * `/nl/blog/x` becomes `{ lang: 'nl', path: '/blog/x', prefixed: true }` when
 * 'nl' is one of the website's declared languages. Paths without a language
 * prefix use the website's default language.
 */
export async function parseLocalizedPath(
  pathname: string,
): Promise<{ lang: string; path: string; prefixed: boolean }> {
  const { defaultLanguage, languages } = await getLanguageConfig();
  const [first, ...rest] = pathname.split("/").filter(Boolean);

  if (first && languages.includes(first)) {
    return { lang: first, path: `/${rest.join("/")}`, prefixed: true };
  }

  return { lang: defaultLanguage, path: pathname, prefixed: false };
}

/** Prefixes a href with the language. The default language keeps its unprefixed URL. */
export function localizePath(
  href: string,
  lang: string,
  defaultLanguage: string,
): string {
  if (lang === defaultLanguage) {
    return href;
  }

  return href === "/" ? `/${lang}` : `/${lang}${href}`;
}

/** The language of a resource. Resources without a `language` property count as the default language. */
export function getResourceLanguage(
  resource: Resource,
  defaultLanguage: string,
): string {
  return resource.get(i18n.properties.language) ?? defaultLanguage;
}

/**
 * All versions of a resource: the canonical resource first, followed by its
 * translations. Translations link to the canonical resource via `translationOf`.
 */
export async function getTranslationGroup(
  resource: Resource,
): Promise<Resource[]> {
  const store = getStore();
  const canonicalSubject =
    resource.get(i18n.properties.translationOf) ?? resource.subject;

  const collection = await new CollectionBuilder(store)
    .setDrive(PUBLIC_ATOMIC_DRIVE)
    .setProperty(i18n.properties.translationOf)
    .setValue(canonicalSubject)
    .addFilter(driveFilter)
    .buildAndFetch();

  const translations = await collection.getAllMembers();
  const subjects = [
    canonicalSubject,
    ...translations.filter((subject) => subject !== canonicalSubject),
  ];

  return Promise.all(subjects.map((subject) => store.getResource(subject)));
}

/**
 * The version of the resource in the given language, or the resource itself
 * when no such translation exists.
 */
export async function findTranslation(
  resource: Resource,
  lang: string,
): Promise<Resource> {
  const { defaultLanguage } = await getLanguageConfig();

  if (getResourceLanguage(resource, defaultLanguage) === lang) {
    return resource;
  }

  const group = await getTranslationGroup(resource);

  return (
    group.find(
      (sibling) => getResourceLanguage(sibling, defaultLanguage) === lang,
    ) ?? resource
  );
}

/**
 * The available translations of a resource as (language, URL) pairs, meant for
 * hreflang alternate links. Includes an `x-default` entry pointing at the
 * canonical version. Returns an empty array when the resource has no translations.
 */
export async function getLanguageAlternates(
  resource: Resource,
): Promise<LanguageLink[]> {
  const { defaultLanguage } = await getLanguageConfig();
  const group = await getTranslationGroup(resource);

  const alternates = group.flatMap((sibling) => {
    const href = sibling.get(website.properties.href);

    if (href === undefined) {
      return [];
    }

    const lang = getResourceLanguage(sibling, defaultLanguage);

    return [{ lang, href: localizePath(href, lang, defaultLanguage) }];
  });

  if (alternates.length < 2) {
    return [];
  }

  // The first entry of the group is the canonical version.
  return [...alternates, { lang: "x-default", href: alternates[0].href }];
}

/**
 * Links to the current page in each of the website's declared languages.
 * Falls back to the homepage of a language when the page has no version in it.
 * Returns an empty array when the website declares fewer than two languages.
 */
export async function getLanguageLinks(
  subject: string,
): Promise<LanguageLink[]> {
  const store = getStore();
  const { defaultLanguage, languages } = await getLanguageConfig();

  if (languages.length < 2) {
    return [];
  }

  const resource = await store.getResource(subject);
  const group = await getTranslationGroup(resource);

  return languages.map((lang) => {
    const version = group.find(
      (sibling) => getResourceLanguage(sibling, defaultLanguage) === lang,
    );
    const href = version?.get(website.properties.href);

    return {
      lang,
      href: localizePath(href ?? "/", lang, defaultLanguage),
    };
  });
}
