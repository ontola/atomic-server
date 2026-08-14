import { CMS_CDN_CACHE_CONTROL, renderRobotsTxt } from "$lib/atomic/feeds";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url }) => {
  return new Response(renderRobotsTxt(url.origin), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": CMS_CDN_CACHE_CONTROL,
    },
  });
};
