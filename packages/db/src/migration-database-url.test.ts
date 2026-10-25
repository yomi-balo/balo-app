import { describe, expect, it } from 'vitest';
import { resolveMigrationDatabaseUrl } from './migration-database-url';

const PASSWORD = 'pw-must-never-be-logged';
const SESSION_POOLER = `postgresql://postgres.ref:${PASSWORD}@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres`;
const TRANSACTION_POOLER = `postgresql://postgres.ref:${PASSWORD}@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres`;
const DEDICATED_TRANSACTION_POOLER = `postgresql://postgres:${PASSWORD}@db.ref.supabase.co:6543/postgres`;
const DIRECT = `postgresql://postgres:${PASSWORD}@db.ref.supabase.co:5432/postgres`;
const PORTLESS = `postgresql://postgres.ref:${PASSWORD}@aws-0-ap-southeast-2.pooler.supabase.com/postgres`;
const CI_EPHEMERAL = 'postgresql://postgres:postgres@localhost:5432/balo_e2e';

function thrownBy(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error('expected the call to throw an Error');
}

describe('resolveMigrationDatabaseUrl', () => {
  it('prefers MIGRATION_DATABASE_URL over the transaction-pooler DATABASE_URL', () => {
    expect(
      resolveMigrationDatabaseUrl({
        MIGRATION_DATABASE_URL: SESSION_POOLER,
        DATABASE_URL: TRANSACTION_POOLER,
      })
    ).toBe(SESSION_POOLER);
  });

  it('falls back to DATABASE_URL when it is not the transaction pooler', () => {
    expect(resolveMigrationDatabaseUrl({ DATABASE_URL: CI_EPHEMERAL })).toBe(CI_EPHEMERAL);
  });

  it('accepts a direct connection', () => {
    expect(resolveMigrationDatabaseUrl({ MIGRATION_DATABASE_URL: DIRECT })).toBe(DIRECT);
  });

  it('accepts a URL without a port when PGPORT is unset (postgres-js then uses 5432)', () => {
    expect(resolveMigrationDatabaseUrl({ MIGRATION_DATABASE_URL: PORTLESS })).toBe(PORTLESS);
  });

  it('treats a blank MIGRATION_DATABASE_URL as unset', () => {
    expect(
      resolveMigrationDatabaseUrl({ MIGRATION_DATABASE_URL: '  ', DATABASE_URL: CI_EPHEMERAL })
    ).toBe(CI_EPHEMERAL);
  });

  it('returns undefined when neither is set, so db:generate needs no database', () => {
    expect(resolveMigrationDatabaseUrl({})).toBeUndefined();
  });

  it.each([
    ['DATABASE_URL', { DATABASE_URL: TRANSACTION_POOLER }],
    ['MIGRATION_DATABASE_URL', { MIGRATION_DATABASE_URL: TRANSACTION_POOLER }],
    ['MIGRATION_DATABASE_URL', { MIGRATION_DATABASE_URL: DEDICATED_TRANSACTION_POOLER }],
    ['MIGRATION_DATABASE_URL', { MIGRATION_DATABASE_URL: PORTLESS, PGPORT: '6543' }],
  ])('refuses the transaction pooler in %s and names the fix', (name, env) => {
    const error = thrownBy(() => resolveMigrationDatabaseUrl(env));

    expect(error.message).toContain(`${name} points at Supabase's transaction pooler (:6543)`);
    expect(error.message).toContain('Set MIGRATION_DATABASE_URL to the session pooler');
    expect(error.message).not.toContain(PASSWORD);
  });

  // An unencoded `#`, `?` or `/` in the password makes the URL unparseable; drizzle-kit would then
  // print postgres-js's ERR_INVALID_URL, whose `input` is the whole URL.
  it.each(['#', '?', '/'])('refuses a password with an unencoded %s without echoing it', (char) => {
    const url = `postgresql://postgres.ref:p${char}${PASSWORD}@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres`;
    const error = thrownBy(() => resolveMigrationDatabaseUrl({ MIGRATION_DATABASE_URL: url }));

    expect(error.message).toContain('MIGRATION_DATABASE_URL is not a valid connection URL');
    expect(error.message).not.toContain(PASSWORD);
    expect(error.cause).toBeUndefined();
  });
});
