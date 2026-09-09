import { section22aRoute } from '@/lib/api/handlers';
import { DEFAULT_SLUG } from '@/lib/projects';

export const dynamic = 'force-dynamic';

/**
 * GET /api/section-22a -> the demo project.
 *
 * A thin alias onto /api/p/siripuram/section-22a, following the same
 * convention as every other unscoped route: the handler body is shared, so
 * alias and scoped route are byte-identical.
 */
export async function GET(req: Request) {
  return section22aRoute(DEFAULT_SLUG, req);
}
