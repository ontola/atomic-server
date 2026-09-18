import {
  CMS_CDN_CACHE_CONTROL,
  renderRobotsTxt,
} from '@/atomic/feeds';

export const revalidate = 60;

export async function GET(request: Request) {
  return new Response(renderRobotsTxt(new URL(request.url).origin), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': CMS_CDN_CACHE_CONTROL,
    },
  });
}
