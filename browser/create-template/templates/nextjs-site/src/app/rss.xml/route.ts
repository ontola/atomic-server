import { getRssItems } from '@/atomic/getPublicPages';
import { renderRssXml } from '@/atomic/feeds';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { title, items } = await getRssItems();
  const xml = renderRssXml(new URL(request.url).origin, title, items);

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
