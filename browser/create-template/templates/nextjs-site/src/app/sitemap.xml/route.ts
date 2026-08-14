import { getSitemapPaths } from '@/atomic/getPublicPages';
import { renderSitemapXml } from '@/atomic/feeds';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const xml = renderSitemapXml(new URL(request.url).origin, await getSitemapPaths());

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
