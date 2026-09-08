import { topologyRoute } from '@/lib/api/handlers';

export const dynamic = 'force-dynamic';

/** GET /api/p/<slug>/topology -> a live 3D clash and clearance run. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  return topologyRoute(slug, req);
}
