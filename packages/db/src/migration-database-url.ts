/**
 * The connection string drizzle-kit connects with (`drizzle.config.ts`): `MIGRATION_DATABASE_URL`,
 * else `DATABASE_URL` — never Supabase's transaction pooler, and for `migrate` and `push` never a
 * remote database that was not named explicitly.
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
 * drizzle-kit loads the config for every command, so `push`, `studio` and `generate` refuse a
 * :6543 URL too.
 *
 * `migrate` and `push` write schema, and Railway's pre-deploy owns the deployed database's
 * migrations. drizzle-kit loads `<cwd>/.env` by itself, and a developer's `packages/db/.env`
 * points `DATABASE_URL` at balo-dev, so a bare `pnpm db:migrate` on a branch would apply unmerged
 * migrations there. Those two commands therefore fall back to `DATABASE_URL` only for a local
 * database (`localhost` or `127.0.0.1`: CI, or Docker with its port published there). A remote
 * database for `migrate` must be named in `MIGRATION_DATABASE_URL`, which Railway sets and which
 * is the explicit override for a hotfix run from a checkout of main only. `push` never has a
 * remote use: it leaves schema the migration tracker doesn't know about.
 *
 * Returns `undefined` when neither variable is set, so `db:generate` keeps working without a
 * database. Errors never include the URL: it carries the password, and the pre-deploy log is
 * readable by everyone on the Railway project.
 *
 * drizzle-kit compiles this module to CommonJS when it loads `drizzle.config.ts`, so it must not
 * use top-level `await` or `import.meta`. Vitest loads it as ESM and would not notice.
 */

const TRANSACTION_POOLER_PORT = '6543';

const URL_VARIABLES = ['MIGRATION_DATABASE_URL', 'DATABASE_URL'] as const;

// Matched by name: drizzle-kit also accepts `--config <path>` BEFORE the command, so "the first
// non-flag argument" would read the config path as the command.
const DRIZZLE_KIT_COMMANDS: ReadonlySet<string> = new Set([
  'generate',
  'migrate',
  'push',
  'pull',
  'introspect',
  'studio',
  'check',
  'up',
  'drop',
  'export',
]);

const SCHEMA_WRITING_COMMANDS: ReadonlySet<string> = new Set(['migrate', 'push']);

// No `[::1]`: drizzle-kit's postgres-js driver can't connect to a bracketed IPv6 host.
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

type UrlVariable = (typeof URL_VARIABLES)[number];

/**
 * @param argv `process.argv` of the drizzle-kit process, which carries the command (`migrate`,
 *   `push`, `generate`, …).
 */
export function resolveMigrationDatabaseUrl(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[] = []
): string | undefined {
  const command = argv.slice(2).find((arg) => DRIZZLE_KIT_COMMANDS.has(arg));
  for (const name of URL_VARIABLES) {
    const url = env[name]?.trim();
    if (url) return checkMigrationUrl(name, url, env.PGPORT?.trim(), command);
  }
  return undefined;
}

function checkMigrationUrl(
  name: UrlVariable,
  url: string,
  pgPort: string | undefined,
  command: string | undefined
): string {
  let port: string;
  let hostname: string;
  try {
    ({ port, hostname } = new URL(url));
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
  // WHATWG URL leaves a postgresql: hostname's case alone.
  if (
    name === 'DATABASE_URL' &&
    command !== undefined &&
    SCHEMA_WRITING_COMMANDS.has(command) &&
    !LOCAL_HOSTS.has(hostname.toLowerCase())
  ) {
    throw new Error(command === 'push' ? PUSH_REFUSAL : MIGRATE_REFUSAL);
  }
  return url;
}

const MIGRATE_REFUSAL =
  'drizzle-kit migrate falls back to DATABASE_URL only for a local database (localhost or ' +
  '127.0.0.1), and this one is not. Railway applies merged migrations on deploy. Run db:migrate ' +
  "yourself only against a local database, and never apply a branch's migrations to balo-dev. " +
  'Only for a hotfix from a checkout of main, name the remote database in MIGRATION_DATABASE_URL. ' +
  'Why: packages/db/src/migration-database-url.ts.';

const PUSH_REFUSAL =
  'drizzle-kit push falls back to DATABASE_URL only for a local database (localhost or ' +
  '127.0.0.1), and this one is not. push is for a local database only: it leaves schema the ' +
  "migration tracker doesn't know about, and the next deploy's migrate fails on it. Why: " +
  'packages/db/src/migration-database-url.ts.';
