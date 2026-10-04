import { describe, it, expect } from 'vitest';
import type { ProductAliasSeed } from './salesforce-taxonomy';
import { flattenProductAliasSeed, renderProductAliasSeedSql } from './taxonomy-seed';

const BREAKPOINT = '\n--> statement-breakpoint\n';

const FIXTURE: Readonly<Record<string, ProductAliasSeed>> = {
  'zeta-cloud': {
    features: ['Zeta Studio', 'Zeta Builder'],
    altNames: ['Old Zeta'],
    hint: "Zeta's cloud: the one with studios.",
  },
  alpha: {
    features: [],
    altNames: ["O'Alpha"],
  },
  'hint-only': {
    features: [],
    altNames: [],
    hint: 'Only a hint.',
  },
};

describe('flattenProductAliasSeed', () => {
  it('keeps the constant’s slug order, features before altNames within a slug', () => {
    expect(flattenProductAliasSeed(FIXTURE)).toEqual([
      { slug: 'zeta-cloud', alias: 'Zeta Studio', kind: 'feature' },
      { slug: 'zeta-cloud', alias: 'Zeta Builder', kind: 'feature' },
      { slug: 'zeta-cloud', alias: 'Old Zeta', kind: 'alt_name' },
      { slug: 'alpha', alias: "O'Alpha", kind: 'alt_name' },
    ]);
  });
});

describe('renderProductAliasSeedSql', () => {
  const rendered = renderProductAliasSeedSql('acme', FIXTURE);
  const statements = rendered.split(BREAKPOINT);

  it('renders exactly the alias INSERT then the hint UPDATE', () => {
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^INSERT INTO "product_aliases"/);
    expect(statements[1]).toMatch(/^UPDATE "products" p SET "ai_hint"/);
  });

  it('renders the alias rows in constant order', () => {
    expect(statements[0]).toContain(
      [
        "  ('zeta-cloud', 'Zeta Studio', 'feature'),",
        "  ('zeta-cloud', 'Zeta Builder', 'feature'),",
        "  ('zeta-cloud', 'Old Zeta', 'alt_name'),",
        "  ('alpha', 'O''Alpha', 'alt_name')",
        ') AS v(slug, alias, kind)',
      ].join('\n')
    );
  });

  it('renders only the slugs that have a hint, in constant order', () => {
    expect(statements[1]).toContain(
      [
        "  ('zeta-cloud', 'Zeta''s cloud: the one with studios.'),",
        "  ('hint-only', 'Only a hint.')",
        ') AS v(slug, hint), "verticals" vt',
      ].join('\n')
    );
    expect(statements[1]).not.toContain("'alpha'");
  });

  it('resolves products by slug within the named vertical — never by a literal id', () => {
    expect(statements[0]).toContain('JOIN "products" p ON p."slug" = v.slug');
    expect(statements[0]).toContain(
      'JOIN "verticals" vt ON vt."id" = p."vertical_id" AND vt."slug" = \'acme\''
    );
    expect(statements[0]).toContain('ON CONFLICT DO NOTHING;');
    expect(statements[1]).toContain(
      'WHERE p."slug" = v.slug AND vt."id" = p."vertical_id" AND vt."slug" = \'acme\';'
    );
  });

  it('escapes a quote in the vertical slug', () => {
    expect(renderProductAliasSeedSql("o'brien", FIXTURE)).toContain("vt.\"slug\" = 'o''brien'");
  });

  it('omits a statement whose row list would be empty', () => {
    const hintsOnly = renderProductAliasSeedSql('acme', {
      only: { features: [], altNames: [], hint: 'h' },
    });
    expect(hintsOnly.startsWith('UPDATE "products"')).toBe(true);
    expect(hintsOnly).not.toContain('statement-breakpoint');

    const aliasesOnly = renderProductAliasSeedSql('acme', {
      only: { features: ['F'], altNames: [] },
    });
    expect(aliasesOnly.startsWith('INSERT INTO "product_aliases"')).toBe(true);
    expect(aliasesOnly).not.toContain('statement-breakpoint');

    expect(renderProductAliasSeedSql('acme', {})).toBe('');
  });
});
