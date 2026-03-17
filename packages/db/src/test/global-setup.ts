import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import path from 'node:path';
import type { TestProject } from 'vitest/node';

const migrationsFolder = path.resolve(__dirname, '../../drizzle');

let container: StartedPostgreSqlContainer;

export async function setup({ provide }: TestProject): Promise<void> {
  container = await new PostgreSqlContainer('postgres:16-alpine').withDatabase('balo_test').start();

  const connectionUri = container.getConnectionUri();

  // Run Drizzle migrations against the test database
  const migrationClient = postgres(connectionUri, { max: 1 });
  const migrationDb = drizzle(migrationClient);
  await migrate(migrationDb, { migrationsFolder });
  await migrationClient.end();

  provide('testDatabaseUrl', connectionUri);
}

export async function teardown(): Promise<void> {
  await container?.stop();
}

// Type-safe provide/inject
declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}
