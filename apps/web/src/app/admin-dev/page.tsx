import { notFound } from 'next/navigation';
import { listUsersAction } from './_actions/list-users';
import { UserTable } from './_components/user-table';

export const dynamic = 'force-dynamic';

export default async function AdminDevPage(): Promise<React.JSX.Element> {
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }

  const users = await listUsersAction();

  return (
    <div
      style={{
        minHeight: '100vh',
        padding: '48px 24px',
        maxWidth: 1100,
        margin: '0 auto',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <div style={{ marginBottom: 32 }}>
        <div
          style={{
            display: 'inline-block',
            padding: '4px 10px',
            borderRadius: 4,
            backgroundColor: '#2d2d2d',
            color: '#f87171',
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            marginBottom: 12,
          }}
        >
          Development Only
        </div>
        <h1 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 4px' }}>
          Admin Dev &mdash; User Management
        </h1>
        <p style={{ color: '#888', fontSize: 14, margin: 0 }}>
          List all signed-up users and delete them individually with full cascade (DB + WorkOS).
          This page has no auth gate and is intended for local development only.
        </p>
      </div>

      <div
        style={{
          padding: '8px 16px',
          borderRadius: 8,
          backgroundColor: '#1a1a1a',
          border: '1px solid #333',
          marginBottom: 24,
          fontSize: 13,
          color: '#888',
        }}
      >
        {users.length} user{users.length !== 1 ? 's' : ''} found
      </div>

      <UserTable users={users} />
    </div>
  );
}
