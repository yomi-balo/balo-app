import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SALESFORCE_PRODUCT_ALIASES } from '../reference-data/salesforce-taxonomy';
import { renderProductAliasSeedSql } from '../reference-data/taxonomy-seed';

/**
 * BAL-592 — DRIFT GUARD between the Salesforce alias seed constant and migration 0105.
 *
 * Two paths seed the same rows: `seed.ts` reads `SALESFORCE_PRODUCT_ALIASES` directly (fresh
 * environments), and migration 0105 carries it rendered as SQL (environments whose products
 * already exist). Nothing else ties the two together, so an alias added to one and not the
 * other would leave dev/prod and a freshly seeded database disagreeing about which labels
 * resolve — silently. This asserts 0105 ENDS WITH the constant's rendering, verbatim.
 *
 * Going red here means the constant changed after 0105 shipped: put the delta in a NEW
 * migration and keep the rendering this test compares against equal to what 0105 applied.
 */

const DRIZZLE_DIR = fileURLToPath(new URL('../../drizzle/', import.meta.url));

function readMigration0105(): string {
  const matches = readdirSync(DRIZZLE_DIR).filter(
    (file) => file.startsWith('0105_') && file.endsWith('.sql')
  );
  expect(matches).toHaveLength(1);
  const [file] = matches;
  if (file === undefined) throw new Error('migration 0105 not found');
  return readFileSync(path.join(DRIZZLE_DIR, file), 'utf8');
}

describe('INVARIANT: migration 0105 seeds exactly the Salesforce alias constant', () => {
  const migration = readMigration0105();
  const rendered = renderProductAliasSeedSql('salesforce', SALESFORCE_PRODUCT_ALIASES);

  it('the rendering is non-empty (guards a vacuous pass)', () => {
    expect(rendered).toContain('INSERT INTO "product_aliases"');
    expect(rendered).toContain('UPDATE "products" p SET "ai_hint"');
  });

  it('ends with the constant rendered by renderProductAliasSeedSql, verbatim', () => {
    expect(migration.trimEnd().endsWith(rendered)).toBe(true);
  });

  it('seeds aliases and hints nowhere else in the migration', () => {
    expect(migration.split('INSERT INTO "product_aliases"')).toHaveLength(2);
    expect(migration.split('SET "ai_hint"')).toHaveLength(2);
  });
});
