import { getRssItems } from "$lib/atomic/getPublicPages";
import { CMS_CDN_CACHE_CONTROL, renderRssXml } from "$lib/atomic/feeds";
import { getStore } from "$lib/atomic/getStore";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, fetch }) => {
  getStore().injectFetch(fetch);
  const { title, items } = await getRssItems();
  const xml = renderRssXml(url.origin, title, items);

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": CMS_CDN_CACHE_CONTROL,
    },
  });
};
