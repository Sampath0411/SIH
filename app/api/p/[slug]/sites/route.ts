import { sitesRoute } from '@/lib/api/handlers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/p/:slug/sites
 *
 * The body lives in lib/api/handlers.ts, beside the cadastre endpoints, so it
 * gets the same project gate, the same caller check and the same compressed,
 * revalidatable payload without restating any of it.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  return sitesRoute(slug, req);
}
