import { topologyRoute } from '@/lib/api/handlers';
import { DEFAULT_SLUG } from '@/lib/projects';

export const dynamic = 'force-dynamic';

/**
 * GET /api/topology -> the demo project.
 *
 * A thin alias onto /api/p/<DEFAULT_SLUG>/topology, for the same reason the
 * other unscoped routes exist: the acceptance scripts and the README's curl
 * examples predate projects. The handler body is shared, so alias and scoped
 * route are byte-identical.
 */
export async function GET(req: Request) {
  return topologyRoute(DEFAULT_SLUG, req);
}
