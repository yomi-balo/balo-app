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

  describe('migrate and push, which write schema', () => {
    const argvFor = (command: string): string[] => [
      '/usr/bin/node',
      '/app/node_modules/drizzle-kit/bin.cjs',
      command,
      '--config',
      'drizzle.config.ts',
    ];

    it('refuses a remote DATABASE_URL for migrate, offering the hotfix override only from main', () => {
      const error = thrownBy(() =>
        resolveMigrationDatabaseUrl({ DATABASE_URL: SESSION_POOLER }, argvFor('migrate'))
      );

      expect(error.message).toContain(
        'drizzle-kit migrate falls back to DATABASE_URL only for a local database'
      );
      expect(error.message).toContain("never apply a branch's migrations to balo-dev");
      expect(error.message).toContain(
        'Only for a hotfix from a checkout of main, name the remote database in MIGRATION_DATABASE_URL'
      );
      expect(error.message).not.toContain(PASSWORD);
    });

    it('refuses a remote DATABASE_URL for push, with no remote override', () => {
      const error = thrownBy(() =>
        resolveMigrationDatabaseUrl({ DATABASE_URL: SESSION_POOLER }, argvFor('push'))
      );

      expect(error.message).toContain(
        'drizzle-kit push falls back to DATABASE_URL only for a local database'
      );
      expect(error.message).toContain('push is for a local database only');
      expect(error.message).not.toContain('MIGRATION_DATABASE_URL');
      expect(error.message).not.toContain(PASSWORD);
    });

    it.each([
      ['localhost (CI)', CI_EPHEMERAL],
      ['127.0.0.1', 'postgresql://postgres:postgres@127.0.0.1:5432/postgres'],
      ['LOCALHOST', 'postgresql://postgres:postgres@LOCALHOST:5432/postgres'],
    ])('falls back to a local DATABASE_URL on %s', (_host, url) => {
      expect(resolveMigrationDatabaseUrl({ DATABASE_URL: url }, argvFor('migrate'))).toBe(url);
    });

    it('accepts a remote database named explicitly in MIGRATION_DATABASE_URL (Railway, a hotfix)', () => {
      expect(
        resolveMigrationDatabaseUrl(
          { MIGRATION_DATABASE_URL: SESSION_POOLER, DATABASE_URL: TRANSACTION_POOLER },
          argvFor('migrate')
        )
      ).toBe(SESSION_POOLER);
    });

    it.each(['generate', 'studio', 'check'])(
      'still lets %s use a remote DATABASE_URL',
      (command) => {
        expect(
          resolveMigrationDatabaseUrl({ DATABASE_URL: SESSION_POOLER }, argvFor(command))
        ).toBe(SESSION_POOLER);
      }
    );

    // drizzle-kit accepts `--config <path>` before the command; the path must not pass for it.
    it.each(['migrate', 'push'])('finds %s after a leading --config <path>', (command) => {
      expect(() =>
        resolveMigrationDatabaseUrl({ DATABASE_URL: SESSION_POOLER }, [
          'node',
          'bin.cjs',
          '--config',
          'drizzle.config.ts',
          command,
        ])
      ).toThrow(`drizzle-kit ${command} falls back`);
    });

    it('treats [::1] as remote, since drizzle-kit cannot connect to it', () => {
      expect(() =>
        resolveMigrationDatabaseUrl(
          { DATABASE_URL: 'postgresql://postgres:postgres@[::1]:5432/postgres' },
          argvFor('migrate')
        )
      ).toThrow(/migrate falls back/);
    });
  });
});
