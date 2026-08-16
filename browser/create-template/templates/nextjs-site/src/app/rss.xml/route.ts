import { getRssItems } from '@/atomic/getPublicPages';
import {
  CMS_CDN_CACHE_CONTROL,
  renderRssXml,
} from '@/atomic/feeds';

export const revalidate = 60;

export async function GET(request: Request) {
  const { title, items } = await getRssItems();
  const xml = renderRssXml(new URL(request.url).origin, title, items);

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': CMS_CDN_CACHE_CONTROL,
    },
  });
}
