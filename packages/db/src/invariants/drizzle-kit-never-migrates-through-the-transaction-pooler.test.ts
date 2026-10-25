import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * drizzle-kit (Railway's pre-deploy `db:migrate`) must never connect through Supabase's
 * transaction pooler. Its own postgres-js client leaves prepared statements on, so once a run
 * commits more than one transaction on a socket (a drizzle upgrade that commits per migration),
 * a named `COMMIT` there can roll back silently while the step exits 0 — see
 * `src/migration-database-url.ts` and `client.ts`.
 *
 * `migration-database-url.test.ts` covers the resolver. This test is the wiring half: it loads
 * the real `drizzle.config.ts`, so pointing `dbCredentials` back at `process.env.DATABASE_URL`, or
 * dropping the `process.argv` that lets `migrate` refuse a remote fallback, or the `<cwd>/.env`
 * check that stops a `MIGRATION_DATABASE_URL` kept in `.env`, fails here even though the resolver
 * suite stays green.
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
  const originalArgv = process.argv;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.argv = originalArgv;
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

  it('refuses a bare `drizzle-kit migrate` against a remote DATABASE_URL', async () => {
    vi.stubEnv('MIGRATION_DATABASE_URL', undefined);
    vi.stubEnv('DATABASE_URL', SESSION_POOLER);
    process.argv = ['node', 'drizzle-kit/bin.cjs', 'migrate'];

    await expect(loadDrizzleConfig()).rejects.toThrow(
      /migrate falls back to DATABASE_URL only for a local database/
    );
  });

  it('refuses a remote MIGRATION_DATABASE_URL for migrate when <cwd>/.env assigns it', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'drizzle-config-'));
    try {
      writeFileSync(join(cwd, '.env'), `MIGRATION_DATABASE_URL=${SESSION_POOLER}\n`);
      vi.spyOn(process, 'cwd').mockReturnValue(cwd);
      vi.stubEnv('MIGRATION_DATABASE_URL', SESSION_POOLER);
      process.argv = ['node', 'drizzle-kit/bin.cjs', 'migrate'];

      await expect(loadDrizzleConfig()).rejects.toThrow(
        /MIGRATION_DATABASE_URL is assigned in \.env/
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
