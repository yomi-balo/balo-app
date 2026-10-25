import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * drizzle-kit (Railway's pre-deploy `db:migrate`) must never connect through Supabase's
 * transaction pooler. Its own postgres-js client leaves prepared statements on, so once a run
 * commits more than one transaction on a socket (a drizzle upgrade that commits per migration),
 * a named `COMMIT` there can roll back silently while the step exits 0 — see
 * `src/migration-database-url.ts` and `client.ts`.
 *
 * `migration-database-url.test.ts` covers the resolver. This test is the wiring half: it loads
 * the real `drizzle.config.ts`, so pointing `dbCredentials` back at `process.env.DATABASE_URL`
 * fails here even though the resolver suite stays green.
 */

const SESSION_POOLER =
  'postgresql://postgres.ref:pw@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres';
const TRANSACTION_POOLER =
  'postgresql://postgres.ref:pw@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres';

async function loadDrizzleConfig(): Promise<unknown> {
  vi.resetModules();
  const { default: config } = await import('../../drizzle.config');
  return config;
}

describe('invariant: drizzle-kit never migrates through the transaction pooler', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('hands drizzle-kit MIGRATION_DATABASE_URL, not the API transaction-pooler DATABASE_URL', async () => {
    vi.stubEnv('MIGRATION_DATABASE_URL', SESSION_POOLER);
    vi.stubEnv('DATABASE_URL', TRANSACTION_POOLER);

    expect(await loadDrizzleConfig()).toMatchObject({ dbCredentials: { url: SESSION_POOLER } });
  });

  it('refuses to load when the transaction pooler is the only URL', async () => {
    vi.stubEnv('MIGRATION_DATABASE_URL', undefined);
    vi.stubEnv('DATABASE_URL', TRANSACTION_POOLER);

    await expect(loadDrizzleConfig()).rejects.toThrow(/transaction pooler \(:6543\)/);
  });
});
