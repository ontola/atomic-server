/**
 * Sitemap / RSS / robots helpers. Kept local so generated sites do not depend
 * on an unreleased `@tomic/lib` export. Canonical copy: `browser/lib/src/cms.ts`.
 */

/**
 * Shared-cache header for public CMS HTML and feeds.
 * `s-maxage` is what CDNs honour; `stale-while-revalidate` keeps serving the
 * last good page while the origin refreshes from AtomicServer.
 */
export const CMS_CDN_CACHE_CONTROL =
  "public, s-maxage=60, stale-while-revalidate=86400";

/** ISR / fetch revalidate window, in seconds. Matches `s-maxage` above. */
export const CMS_REVALIDATE_SECONDS = 60;

/** Pathname `/nl/blog/x` → catch-all slug `['nl', 'blog', 'x']`. `/` → `[]`. */
export function cmsPathToSlug(path: string): string[] {
  if (!path || path === "/") {
    return [];
  }

  return path.split("/").filter(Boolean);
}

/** Prefix an internal href with a language. The default language stays unprefixed. */
export function localizeCmsPath(
  href: string,
  lang: string,
  defaultLanguage: string,
): string {
  if (lang === defaultLanguage) {
    return href;
  }

  return href === "/" ? `/${lang}` : `/${lang}${href}`;
}

/**
 * Public URL paths for a sitemap: each listed href, once per declared language.
 * Callers must already have dropped forks and unpublished posts.
 */
export function cmsSitemapPaths(
  hrefs: Iterable<string>,
  languages: string[],
  defaultLanguage: string,
): string[] {
  const paths = new Set<string>();
  const langs = languages.length > 0 ? languages : [defaultLanguage];

  for (const href of hrefs) {
    if (
      !href ||
      href.startsWith("http://") ||
      href.startsWith("https://") ||
      href.startsWith("#") ||
      href.startsWith("mailto:")
    ) {
      continue;
    }

    const normalized = href.startsWith("/") ? href : `/${href}`;

    for (const lang of langs) {
      paths.add(localizeCmsPath(normalized, lang, defaultLanguage));
    }
  }

  return [...paths].sort();
}

export function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderSitemapXml(origin: string, paths: string[]): string {
  const originTrimmed = origin.replace(/\/$/, "");
  const urls = paths
    .map((path) => {
      const loc = `${originTrimmed}${path === "/" ? "/" : path}`;

      return `  <url>\n    <loc>${escapeXml(loc)}</loc>\n  </url>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function renderRobotsTxt(origin: string): string {
  const originTrimmed = origin.replace(/\/$/, "");

  return `User-agent: *\nAllow: /\nSitemap: ${originTrimmed}/sitemap.xml\n`;
}

export type CmsRssItem = {
  title: string;
  path: string;
  description?: string;
  publishedAt?: number;
};

export function renderRssXml(
  origin: string,
  title: string,
  items: CmsRssItem[],
): string {
  const originTrimmed = origin.replace(/\/$/, "");
  const itemXml = items
    .map((item) => {
      const link = `${originTrimmed}${item.path}`;
      const parts = [
        `    <title>${escapeXml(item.title)}</title>`,
        `    <link>${escapeXml(link)}</link>`,
        `    <guid>${escapeXml(link)}</guid>`,
      ];

      if (item.description) {
        parts.push(
          `    <description>${escapeXml(item.description)}</description>`,
        );
      }

      if (item.publishedAt !== undefined) {
        parts.push(
          `    <pubDate>${escapeXml(new Date(item.publishedAt).toUTCString())}</pubDate>`,
        );
      }

      return `  <item>\n${parts.join("\n")}\n  </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n<channel>\n  <title>${escapeXml(title)}</title>\n  <link>${escapeXml(originTrimmed)}/</link>\n  <description>${escapeXml(title)}</description>\n${itemXml}\n</channel>\n</rss>\n`;
}
