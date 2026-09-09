import { section22aRoute } from '@/lib/api/handlers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/p/:slug/section-22a -> the Section 22A restricted-land register.
 *
 * A GeoJSON FeatureCollection of the listed parcels, plus a `register` block
 * naming the source, whether it is authoritative, and how many entries could
 * not be placed on the map. `x-ulpin-22a-source` names the register in a header
 * so a caller can tell a demonstration list from a government one without
 * reading the body.
 *
 * The body lives in lib/api/handlers.ts, shared with the unscoped alias so the
 * two can never answer differently.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  return section22aRoute(slug, req);
}
