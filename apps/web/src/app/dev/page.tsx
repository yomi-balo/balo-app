import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SeedPanel } from './_components/seed-panel';

export const dynamic = 'force-dynamic';

const links: {
  section: string;
  items: { href: string; label: string; description: string; external?: boolean }[];
}[] = [
  {
    section: 'Verification Pages',
    items: [
      {
        href: '/test-db',
        label: 'Test DB Connection',
        description: 'Queries users and verticals tables',
      },
      {
        href: '/test-error',
        label: 'Test Sentry Error',
        description: 'Throws a client error to verify Sentry capture',
      },
      {
        href: '/api/health',
        label: 'Health Check (Web)',
        description: 'Returns app version and status',
      },
    ],
  },
  {
    section: 'Auth',
    items: [{ href: '/login', label: 'Login', description: 'WorkOS OAuth sign-in flow' }],
  },
  {
    section: 'External Tools',
    items: [
      {
        href: 'https://local.drizzle.studio',
        label: 'Drizzle Studio',
        description: 'Database browser (run pnpm --filter db db:studio)',
        external: true,
      },
      {
        href: 'https://supabase.com/dashboard',
        label: 'Supabase Dashboard',
        description: 'Database management',
        external: true,
      },
      {
        href: 'https://dashboard.workos.com',
        label: 'WorkOS Dashboard',
        description: 'Auth provider config',
        external: true,
      },
      {
        href: 'https://sentry.io',
        label: 'Sentry',
        description: 'Error tracking dashboard',
        external: true,
      },
      {
        href: 'https://eu.posthog.com',
        label: 'PostHog',
        description: 'Analytics dashboard',
        external: true,
      },
      {
        href: 'https://dashboard.stripe.com/test',
        label: 'Stripe (Test)',
        description: 'Payments dashboard',
        external: true,
      },
      {
        href: 'https://app.axiom.co',
        label: 'Axiom',
        description: 'Log aggregation',
        external: true,
      },
    ],
  },
  {
    section: 'API (port 3001)',
    items: [
      {
        href: 'http://localhost:3001/health',
        label: 'Health Check (API)',
        description: 'Fastify API status',
        external: true,
      },
    ],
  },
];

export default function DevDashboardPage() {
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }

  const cardClass =
    'border-border hover:border-muted-foreground/40 hover:bg-muted/50 block rounded-lg border p-4 text-foreground no-underline transition-colors';

  return (
    <div className="bg-background text-foreground min-h-screen px-6 py-12">
      <div className="mx-auto max-w-3xl">
        <header className="mb-10">
          <span className="bg-warning text-warning-foreground mb-3 inline-block rounded px-2.5 py-1 text-xs font-semibold tracking-wide uppercase">
            Development Only
          </span>
          <h1 className="text-3xl font-semibold tracking-tight">Dev Dashboard</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Quick links for local development and verification.
          </p>
        </header>

        <div className="mb-10">
          <SeedPanel />
        </div>

        <div className="flex flex-col gap-8">
          {links.map((group) => (
            <section key={group.section}>
              <h2 className="text-muted-foreground border-border mb-3 border-b pb-2 text-xs font-semibold tracking-wide uppercase">
                {group.section}
              </h2>
              <div className="flex flex-col gap-2">
                {group.items.map((item) => {
                  const content = (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="text-foreground text-[15px] font-medium">
                          {item.label}
                        </span>
                        {item.external && (
                          <span className="text-muted-foreground text-xs" aria-hidden="true">
                            ↗
                          </span>
                        )}
                      </div>
                      <p className="text-muted-foreground mt-1 text-[13px]">{item.description}</p>
                    </>
                  );

                  return item.external ? (
                    <a
                      key={item.href}
                      href={item.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cardClass}
                    >
                      {content}
                    </a>
                  ) : (
                    <Link key={item.href} href={item.href} className={cardClass}>
                      {content}
                    </Link>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
