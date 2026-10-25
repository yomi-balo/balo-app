import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';
import {
  dotEnvDefinesMigrationUrl,
  resolveMigrationDatabaseUrl,
} from './src/migration-database-url';

// drizzle-kit has already loaded this file into process.env before the config runs.
const dotEnvPath = resolve(process.cwd(), '.env');

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: resolveMigrationDatabaseUrl(process.env, {
      argv: process.argv,
      dotEnvDefinesMigrationUrl:
        existsSync(dotEnvPath) && dotEnvDefinesMigrationUrl(readFileSync(dotEnvPath, 'utf8')),
    })!,
  },
});
