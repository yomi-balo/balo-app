import Link from 'next/link';

const links = [
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
  return (
    <>
      <style>{`
        .dev-card {
          display: block;
          padding: 14px 16px;
          border-radius: 8px;
          border: 1px solid #333;
          text-decoration: none;
          color: inherit;
          transition: border-color 0.15s, background-color 0.15s;
        }
        .dev-card:hover {
          border-color: #555;
          background-color: #1a1a1a;
        }
      `}</style>
      <div
        style={{
          minHeight: '100vh',
          padding: '48px 24px',
          maxWidth: 720,
          margin: '0 auto',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <div style={{ marginBottom: 40 }}>
          <div
            style={{
              display: 'inline-block',
              padding: '4px 10px',
              borderRadius: 4,
              backgroundColor: '#2d2d2d',
              color: '#a78bfa',
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              marginBottom: 12,
            }}
          >
            Development Only
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 4px' }}>Dev Dashboard</h1>
          <p style={{ color: '#888', fontSize: 14, margin: 0 }}>
            Quick links for local development and verification.
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
          {links.map((group) => (
            <section key={group.section}>
              <h2
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: '#888',
                  marginBottom: 12,
                  paddingBottom: 8,
                  borderBottom: '1px solid #333',
                }}
              >
                {group.section}
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {group.items.map((item) => {
                  const content = (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 500, fontSize: 15 }}>{item.label}</span>
                        {item.external && <span style={{ color: '#666', fontSize: 12 }}>↗</span>}
                      </div>
                      <p style={{ color: '#777', fontSize: 13, margin: '4px 0 0' }}>
                        {item.description}
                      </p>
                    </>
                  );

                  return item.external ? (
                    <a
                      key={item.href}
                      href={item.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="dev-card"
                    >
                      {content}
                    </a>
                  ) : (
                    <Link key={item.href} href={item.href} className="dev-card">
                      {content}
                    </Link>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
