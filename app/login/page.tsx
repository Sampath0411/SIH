import { redirect } from 'next/navigation';
import { listProjects, DEFAULT_SLUG, isValidSlug } from '@/lib/projects';
import { currentSession } from '@/lib/auth/guards';
import LoginForm from './LoginForm';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Sign in — 3D ULPIN',
};

/**
 * The login page.
 *
 * If a session is already valid, the user is sent to their project
 * (citizen -> their building, gov -> the demo project). The form is
 * only rendered when no session is present.
 *
 * The list of projects the citizen can pick from is rendered from the
 * same registry the rest of the application reads, so adding a project
 * shows up in the dropdown without further changes.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const me = await currentSession();
  if (me) {
    if (me.kind === 'gov') {
      redirect('/');
    } else {
      redirect(`/p/${me.claims.slug}`);
    }
  }

  const projects = await listProjects();
  const defaultProject = projects[0]?.slug ?? DEFAULT_SLUG;

  // ?next= is what RoleGate writes when a project page bounces an
  // unauthenticated visitor. It must round-trip back to the page they were
  // trying to reach, not be silently dropped. The validation here is
  // deliberately tight: only an internal path that begins with /p/<slug>
  // for a slug the registry knows about, with NOTHING after the slug
  // (no slash, query, fragment, or path-traversal), so the parameter
  // cannot be used as an open redirect to an attacker URL. Anything
  // else falls back to the login's own default.
  const params = await searchParams;
  const safeNext = (() => {
    const candidate = params.next;
    if (typeof candidate !== 'string') return null;
    if (!candidate.startsWith('/p/')) return null;
    const rest = candidate.slice(3);
    // Reject any path that has anything past the slug: a second `/`
    // (e.g. /p/siripuram/../admin), a `?`, a `#`, or a percent-encoded
    // sibling. router.push resolves the path client-side, so a value of
    // `/p/siripuram/../admin` would land the user on `/admin` -- a
    // same-origin redirect, not a cross-origin open redirect, but still
    // outside the validator's stated intent.
    if (!/^[A-Za-z0-9_-]+$/.test(rest)) return null;
    if (!isValidSlug(rest)) return null;
    if (!projects.some((p) => p.slug === rest)) return null;
    return candidate;
  })();

  // The demo credentials block is a developer convenience: a fresh
  // checkout that points a browser at /login should be usable without
  // reading the docs. The dev environment is the right scope -- a
  // production deployment must not render the government's plaintext
  // password in HTML any unauthenticated visitor can read, and the demo
  // password is committed knowledge anyway. The block is preserved
  // verbatim in dev so a developer running `npm run dev` still gets
  // the same one-click path they had before this gate.
  const showDemoCreds = process.env.NODE_ENV !== 'production';

  return (
    <main className="grid min-h-dvh w-screen place-items-center bg-bg px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <p className="panel-title">3D ULPIN — Sign in</p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-ink">
            Citizen or government?
          </h1>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            A citizen sees their own flat, its parking bay and its certificate,
            and nothing else in the building. A government official sees the
            full AOI, with every control.
          </p>
        </div>
        <LoginForm
          projects={projects.map((p) => ({ slug: p.slug, name: p.name }))}
          defaultProject={defaultProject}
          next={safeNext ?? undefined}
        />
        {showDemoCreds ? (
          <p className="mt-6 text-center text-[11px] leading-relaxed text-muted">
            Demo residents of Sampath Skyline:
            <br />
            Flat 201, Ravi Kumar ·{' '}
            <span className="font-mono text-ink">111122223333 / 9876543210</span>
            <br />
            Flat 502, Priya Sharma ·{' '}
            <span className="font-mono text-ink">222233334444 / 9876543211</span>
            <br />
            Flat 903, Anand Rao ·{' '}
            <span className="font-mono text-ink">333344445555 / 9876543212</span>
            <br />
            Government: <span className="font-mono text-ink">admin@sampath.gov.in</span> /
            {' '}<span className="font-mono text-ink">ulpin-gov-2026</span>
          </p>
        ) : null}
      </div>
    </main>
  );
}
