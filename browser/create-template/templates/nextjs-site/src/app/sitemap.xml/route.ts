import { getSitemapPaths } from '@/atomic/getPublicPages';
import {
  CMS_CDN_CACHE_CONTROL,
  renderSitemapXml,
} from '@/atomic/feeds';

export const revalidate = 60;

export async function GET(request: Request) {
  const xml = renderSitemapXml(new URL(request.url).origin, await getSitemapPaths());

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': CMS_CDN_CACHE_CONTROL,
    },
  });
}
