import { ladmSpatialUnitRoute } from '@/lib/api/handlers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/p/:slug/ladm/spatial-unit/:suId -> the ISO 19152 document for one
 * spatial unit: LA_SpatialUnit, its LA_BAUnit and every member's share, the
 * LA_RRRs against that bundle, the LA_Parties holding them, and the
 * subterranean easements crossing it.
 *
 * GeoJSON-3D by default; JSON-LD on `?format=jsonld` or an
 * `Accept: application/ld+json`.
 *
 * NO UNSCOPED ALIAS. New endpoints skip it -- the aliases exist because the
 * acceptance scripts and the README's curl examples predate projects, and
 * nothing predates this one. The slug-free form that DOES exist,
 * /api/v1/ladm/parcel/:ulpin3d, is a different thing: it resolves the project
 * from the identifier rather than hardcoding the demo AOI.
 *
 * The body lives in lib/api/handlers.ts, shared with that route so the two can
 * never answer differently.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string; suId: string }> },
) {
  const { slug, suId } = await ctx.params;
  return ladmSpatialUnitRoute(slug, suId, req);
}
