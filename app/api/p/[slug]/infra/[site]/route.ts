import { siteSpecRoute } from '@/lib/api/handlers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/p/:slug/infra/:site
 *
 * One site's full specification. Its own endpoint rather than a field on
 * /sites, because this is where the lazy load happens: the index lists what
 * exists, and a whole station only crosses the wire when somebody opens it.
 *
 * There is deliberately NO unscoped alias. The cadastre endpoints have one for
 * backward compatibility with the single-project era; sites never existed then,
 * so an alias would only add a second URL that has to be kept in step.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string; site: string }> },
) {
  const { slug, site } = await ctx.params;
  return siteSpecRoute(slug, site, req);
}
