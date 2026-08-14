import { getSitemapPaths } from "$lib/atomic/getPublicPages";
import { renderSitemapXml } from "$lib/atomic/feeds";
import { getStore } from "$lib/atomic/getStore";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, fetch }) => {
  getStore().injectFetch(fetch);
  const xml = renderSitemapXml(url.origin, await getSitemapPaths());

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
};
