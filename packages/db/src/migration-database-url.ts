/**
 * The connection string drizzle-kit connects with (`drizzle.config.ts`): `MIGRATION_DATABASE_URL`,
 * else `DATABASE_URL` — and never Supabase's transaction pooler.
 *
 * drizzle-kit builds its own postgres-js client (`postgres(url, { max: 1 })`), so `prepare` stays
 * at its default `true` and `COMMIT` goes out as a named prepared statement. Through the
 * transaction pooler, a named `COMMIT` in a socket's second transaction is the path `client.ts`
 * documents as rolling back silently. Today's migrator opens one transaction per run, so it never
 * gets there, but nothing pins that: a drizzle-kit or drizzle-orm upgrade that commits per
 * migration would lose migrations while the step still exits 0. Supabase also recommends a direct
 * or session-pooler connection for DDL. So the deployed API keeps `DATABASE_URL` on the
 * transaction pooler (:6543), and migrations get their own URL: the session pooler (the shared
 * `*.pooler.supabase.com` host on port 5432) or a direct connection.
 *
 * Port 6543 is transaction-only on both Supabase poolers (shared Supavisor and dedicated
 * PgBouncer), so the port postgres-js will use (the URL's, else `PGPORT`) identifies it.
 * drizzle-kit loads the config for every command, so
 * `push`, `studio` and `generate` refuse a :6543 URL too. Returns `undefined` when neither variable
 * is set, so `db:generate` keeps working without a database. Errors never include the URL: it
 * carries the password, and the pre-deploy log is readable by everyone on the Railway project.
 *
 * drizzle-kit compiles this module to CommonJS when it loads `drizzle.config.ts`, so it must not
 * use top-level `await` or `import.meta`. Vitest loads it as ESM and would not notice.
 */

const TRANSACTION_POOLER_PORT = '6543';

const URL_VARIABLES = ['MIGRATION_DATABASE_URL', 'DATABASE_URL'] as const;

export function resolveMigrationDatabaseUrl(
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  for (const name of URL_VARIABLES) {
    const url = env[name]?.trim();
    if (url) return refuseTransactionPooler(name, url, env.PGPORT?.trim());
  }
  return undefined;
}

function refuseTransactionPooler(name: string, url: string, pgPort: string | undefined): string {
  let port: string;
  try {
    ({ port } = new URL(url));
  } catch {
    // Not rethrown: the URL parser's error carries the input, password included.
    throw new Error(`${name} is not a valid connection URL, so drizzle-kit will not use it.`);
  }
  // postgres-js falls back to PGPORT when the URL names no port.
  if ((port || pgPort) === TRANSACTION_POOLER_PORT) {
    throw new Error(
      `${name} points at Supabase's transaction pooler (:${TRANSACTION_POOLER_PORT}), which drizzle-kit ` +
        'must not migrate through. Set MIGRATION_DATABASE_URL to the session pooler (the shared ' +
        '*.pooler.supabase.com host on port 5432) or a direct connection. Why: ' +
        'packages/db/src/migration-database-url.ts.'
    );
  }
  return url;
}
