import { renderRobotsTxt } from '@/atomic/feeds';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return new Response(renderRobotsTxt(new URL(request.url).origin), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
