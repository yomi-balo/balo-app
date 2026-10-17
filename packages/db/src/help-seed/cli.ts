import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../schema';
import {
  parseMondayAnchor,
  resetHelpFixture,
  seedHelpFixture,
  setHelpAvailability,
  type HelpAvailabilityState,
} from './fixture';

type Command =
  | { kind: 'seed'; anchor: Date }
  | { kind: 'state'; state: HelpAvailabilityState }
  | { kind: 'reset' };

function flagValue(args: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

/** Validates argv without touching the database, so bad input fails before any connection. */
function parseCommand(argv: readonly string[]): Command {
  // pnpm forwards a literal `--` before script arguments; it carries no meaning here.
  const [command, ...rest] = argv.filter((arg) => arg !== '--');
  if (command === 'seed') {
    return { kind: 'seed', anchor: parseMondayAnchor(flagValue(rest, 'anchor')) };
  }
  if (command === 'state') {
    const [state] = rest;
    if (state !== 'available' && state !== 'paused') {
      throw new Error('usage: state <available|paused>');
    }
    return { kind: 'state', state };
  }
  if (command === 'reset') {
    return { kind: 'reset' };
  }
  throw new Error('usage: cli.ts <seed --anchor=YYYY-MM-DD | state <available|paused> | reset>');
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The fixture hard-deletes and rewrites rows, so it only ever runs against a local database. */
function assertLocalDatabase(connectionString: string): void {
  let hostname: string;
  try {
    hostname = new URL(connectionString).hostname;
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (!LOCAL_HOSTNAMES.has(hostname)) {
    throw new Error(
      `Refusing to run: DATABASE_URL host "${hostname}" is not local. The help fixture only runs against localhost.`
    );
  }
}

async function run(command: Command): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  assertLocalDatabase(connectionString);
  // `prepare: false`: a named COMMIT silently rolls back otherwise (see packages/db/src/client.ts).
  const client = postgres(connectionString, { max: 1, prepare: false });
  const db = drizzle(client, { schema });
  try {
    if (command.kind === 'seed') {
      await db.transaction((tx) => seedHelpFixture(tx, command.anchor));
    } else if (command.kind === 'reset') {
      await db.transaction((tx) => resetHelpFixture(tx));
    } else {
      await setHelpAvailability(db, command.state);
    }
  } finally {
    await client.end();
  }
}

try {
  await run(parseCommand(process.argv.slice(2)));
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
