# Using Atomic as a headless CMS

AtomicServer is the content store. The Data Browser is the editor. A generated Next.js or SvelteKit site is the public front-end. Content lives as typed resources in a Drive; the site queries them over HTTP.

This is the supported product path. If you want to model a site from scratch instead, see [the Astro guide](astro-guide/1-index.md).

## What you get

- Pages, nested menus, and blog posts you edit in the Data Browser
- A generated Next.js or SvelteKit app that renders that data
- Cmd/Ctrl+E (and an **Edit this page** link) from the live site back into the editor
- Document-level translations (`language` + `translationOf`)
- Scheduled posts: a `published-at` in the future is stored but not listed or routed
- `sitemap.xml`, `robots.txt`, and `rss.xml` generated from the same public-content filter

Authorization is still location. Making the Drive publicly readable publishes everything in it. A future `published-at` is presentation, not an ACL. Staging a change to an existing page is [Edit as fork](commits/suggestions.md) — forks are excluded from the public site, sitemap, and RSS.

## 1. Run AtomicServer

Install and start a server ([installation](atomicserver/installation.md)). Locally:

```sh
atomic-server --port 9883
```

Open `http://localhost:9883`, accept the `/setup` invite, and keep your agent secret.

The **server URL** is this HTTP origin (`http://localhost:9883`). It is not the Drive's `did:ad:` identifier. After the DID migration those are different values, and mixing them up is the usual way a new site fails to load.

## 2. Create a Drive and apply the Website template

1. Create a Drive (sidebar **+**, then **Drive**).
2. Grant public read on that Drive (share dialog → add the Public Agent). The scaffolder and the generated site both fetch without an agent.
3. Sidebar **+** → **Templates** → **website** → **Apply template**.

You now have sample pages, a blog, a two-locale balloon post, and a scheduled post dated 2030 that the generated site must not show.

Copy two values:

| Value | Where |
| --- | --- |
| Server URL | The origin in the address bar, e.g. `http://localhost:9883` |
| Drive subject | The Drive's `did:ad:…` id (address bar `?subject=`, or the bottom bar while viewing the Drive) |

## 3. Generate the front-end

```sh
pnpm create @tomic/template my-site --template sveltekit-site \
  --server-url http://localhost:9883 \
  --drive did:ad:YOUR_DRIVE
```

Use `--template nextjs-site` for Next.js. If the Data Browser is not served from the same origin as the API (Vite on `:6747`, server on `:9883`/`:9885`), also pass `--cms-url http://localhost:6747`.

Then:

```sh
cd my-site
pnpm install
pnpm update-ontologies
pnpm dev
```

`update-ontologies` pulls the Website ontology from your server and writes TypeScript types. Re-run it after you change classes or properties.

Open the printed localhost URL. You should see the homepage copy from the template.

## 4. Edit content

In the Data Browser, open **Site Data**. Change a text block, add a blog post, or rename a menu item, then refresh the generated site.

From the generated site, press **Cmd/Ctrl+E** or click **Edit this page** in the footer. That opens `/app/edit?subject=…` on the Data Browser. Sign-in stays in the editor; the public bundle never embeds an agent secret.

Blog posts:

- `href` / `path` is the public URL, relative to the site root (`/blog/my-post`).
- The Website resource's **homepage** property is what `/` (and `/nl`) serve. Change it in the Data Browser to point at a different page without renaming paths.
- `published-at` in the future hides the post from listings, search, and direct routes.
- `cover-image` and `published-at` are recommended, not required, so you can save an incomplete post. Until it has a `published-at` in the past, it stays off the site.
- `/sitemap.xml` lists every public page and post in each declared language. `/rss.xml` is the blog feed. Both omit forks and unpublished posts. `/robots.txt` points crawlers at the sitemap.

Generated pages are built to sit behind a CDN. Next.js prerenders every public path (`generateStaticParams`) and revalidates every 60 seconds (ISR). SvelteKit prerenders those same paths and sets `Cache-Control: public, s-maxage=60, stale-while-revalidate=86400` on HTML and feeds. Language lives in the URL (`/nl/...`) and in the first HTML byte (`<html lang="nl">`), so a cached file is already the right locale — no client round-trip to fix it. Blog search filters the prerendered list in the browser so `/blog` stays cacheable.

A new post appears on the site within that 60-second window, or immediately after a rebuild. Put Cloudflare, Netlify, or Fastly in front and honour `s-maxage`; do not override it with `no-store`.

## 5. Translations

The Website resource has `defaultLanguage` (`en`) and `languages` (`en`, `nl`). A translation is a normal page or blog post with:

- `language` — BCP 47 tag (`nl`)
- `translationOf` — the canonical resource
- its own `path` (`/blog/de-biologie-van-ballondieren`)

The templates resolve `/nl/blog/the-english-slug` to the Dutch sibling, list one version per post, and emit `hreflang`. Nav links and blog cards keep the current language prefix (`/nl/blog` → Home is `/nl`, a Coffee card stays under `/nl/blog/...`). See [Translations & Localization](schema/translations.md).

## 6. Caching and CDNs

The public site is static HTML plus a short shared-cache lifetime:

- **Next.js:** `generateStaticParams` prerenders every listed path. `revalidate = 60` (ISR) and `fetch` `next.revalidate` keep AtomicServer reads from being baked empty forever. Feeds send `Cache-Control: public, s-maxage=60, stale-while-revalidate=86400`.
- **SvelteKit:** `entries()` prerenders those paths; `hooks.server.ts` sets the same `Cache-Control` on HTML, sitemap, RSS, and robots. New URLs after publish still SSR on demand and are then cacheable.
- **Language** is in the path and in `<html lang>` of the first byte. `/nl/blog/...` is a different cache key from `/blog/...`.
- **Search** is client-side over the already-rendered list, so `/blog` is not `?search=`-dynamic.

Empty listings at build are retried a few times, then expire in 60 seconds instead of sticking until the next deploy.

## 7. What this is not (yet)

- **Confidential drafts next to a public site.** Rights are additive. A private Drafts folder only stays private if the Drive itself is not blanket-public; grant public read on the site folder instead. That workflow is not wired into the template yet.
- **In-page editing.** Cmd/Ctrl+E goes to the Data Browser; the generated site is a reader.
- **Image resizing.** Files are stored as uploaded ([issue](https://github.com/atomicdata-dev/atomic-server/issues/257)).
- **GraphQL.** Query with collections, `@tomic/lib`, or the REST/JSON-AD API ([issue](https://github.com/atomicdata-dev/atomic-server/issues/251)).

## Next

- Template CLI reference: [@tomic/template](create-template/atomic-template.md)
- Modelling from scratch: [Astro + Atomic](astro-guide/1-index.md)
- `@tomic/react` hooks: [React](usecases/react.md)
- `@tomic/svelte`: [Svelte](svelte.md)
