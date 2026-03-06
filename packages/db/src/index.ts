// Client
export { db, type Database } from './client';

// Schema (tables, types, enums)
export * from './schema';

// Repositories (data access layer)
export * from './repositories';

// Re-export commonly used drizzle-orm operators to avoid version mismatch issues.
// Consumers should import these from '@balo/db' instead of 'drizzle-orm' directly.
export { eq, and, or, not, inArray, sql, desc, asc } from 'drizzle-orm';
