import { conflictsRoute } from '@/lib/api/handlers';
import { DEFAULT_SLUG } from '@/lib/projects';

export const dynamic = 'force-dynamic';

/**
 * GET /api/conflicts -> the demo project.
 *
 * A thin alias onto /api/p/<DEFAULT_SLUG>/conflicts. It exists because the
 * acceptance scripts, the README's curl examples and any bookmarked URL all
 * predate projects, and an unscoped path that 404s would break every one of
 * them. The handler body is shared, so alias and scoped route are
 * byte-identical.
 */
export async function GET(req: Request) {
  return conflictsRoute(DEFAULT_SLUG, req);
}
