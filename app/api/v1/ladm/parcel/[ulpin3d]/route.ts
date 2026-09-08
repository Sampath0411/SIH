import { ladmByIdentifierRoute } from '@/lib/api/handlers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/ladm/parcel/:ulpin3d -> the ISO 19152 document for the spatial
 * unit that identifier names, in whichever project issued it.
 *
 * THE PROJECT IS RESOLVED FROM THE IDENTIFIER. An su_id carries the revenue
 * codes -- AP-VSP-3D26 -- that projects.state_code / district_code /
 * scheme_code hold, so the AOI is derivable and the caller does not have to
 * know a slug. That is what makes a versioned, slug-free namespace coherent
 * rather than a second hardcoded alias for the demo project.
 *
 * IT IS ALSO THE URL THE EXPORTED CERTIFICATE'S QR CODE CARRIES, which is the
 * reason it is slug-free: a deed is a document somebody keeps, and a slug can
 * be renamed. The revenue codes cannot -- they are the identifier.
 *
 * `:ulpin3d` accepts any spatial-unit identifier, not only a 3D ULPIN: a
 * surface plot (AP-VSP-3D26-0042), a volume (…-0042-007-09-901) and a utility
 * corridor (AP-VSP-3D26-UTL-00042) all resolve. The segment keeps the name
 * the API contract was specified with.
 *
 * WHY /v1 AND NOT /api/ladm. Everything else here is unversioned because it
 * serves this application's own viewer, which ships with it. This one is a
 * standards-shaped document meant to be consumed by something that is not
 * this repository, and a consumer that is not in the repository cannot be
 * migrated by editing it.
 *
 * The body lives in lib/api/handlers.ts, shared with the scoped route.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ ulpin3d: string }> },
) {
  const { ulpin3d } = await ctx.params;
  return ladmByIdentifierRoute(ulpin3d, req);
}
