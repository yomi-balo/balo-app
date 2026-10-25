import { defineConfig } from 'drizzle-kit';
import { resolveMigrationDatabaseUrl } from './src/migration-database-url';

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: resolveMigrationDatabaseUrl(process.env, process.argv)!,
  },
});
