import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import * as schema from '../schema';

const migrationsFolder = path.resolve(__dirname, '../../drizzle');

let container: StartedPostgreSqlContainer;

export async function setup({ provide }: TestProject): Promise<void> {
  container = await new PostgreSqlContainer('postgres:16-alpine').withDatabase('balo_test').start();

  const connectionUri = container.getConnectionUri();

  // Run Drizzle migrations against the test database
  const migrationClient = postgres(connectionUri, { max: 1 });
  const migrationDb = drizzle(migrationClient, { schema });
  await migrate(migrationDb, { migrationsFolder });

  // Seed reference data that factories depend on (not rolled back per-test)
  await seedReferenceData(migrationDb);

  await migrationClient.end();

  provide('testDatabaseUrl', connectionUri);
}

/** Seed the minimal reference data needed by test factories */
async function seedReferenceData(db: ReturnType<typeof drizzle<typeof schema>>): Promise<void> {
  // Salesforce vertical (required by expertFactory)
  await db
    .insert(schema.verticals)
    .values({
      name: 'Salesforce',
      slug: 'salesforce',
      description: 'Salesforce ecosystem',
      isActive: true,
    })
    .onConflictDoNothing();
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
