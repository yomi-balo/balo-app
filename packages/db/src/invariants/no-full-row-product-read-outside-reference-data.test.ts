import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripComments } from '@balo/shared/testing';

/**
 * BAL-592 — `products.ai_hint` is internal prompt text. A full-row read of `products` hands
 * it to whoever receives the result, and several repository reads reach client components.
 *
 * Every repository must therefore read `products` through an explicit column list
 * (`columns: { aiHint: false }` on a relational read, a named projection on a `select`).
 * This invariant fails on the two shapes that read every column:
 *   (a) relational hydration — `product: true` / `products: true`;
 *   (b) a full-row select — `.select().from(products)` / `.from(schema.products)`.
 *
 * Source is comment-stripped and whitespace-collapsed before an indexOf scan (never a
 * backtracking regex, S5852), so formatting cannot hide a match. No allow-list: no
 * repository needs a full-row read of `products` today.
 *
 * If this test fails: add `columns: { aiHint: false }` (or select the columns needed).
 */

const REPOSITORIES_DIR = fileURLToPath(new URL('../repositories/', import.meta.url));

const FORBIDDEN_SHAPES: readonly { readonly label: string; readonly needle: string }[] = [
  { label: 'relational `product: true`', needle: 'product:true' },
  { label: 'relational `products: true`', needle: 'products:true' },
  { label: 'full-row `.select().from(products)`', needle: '.select().from(products)' },
  {
    label: 'full-row `.select().from(schema.products)`',
    needle: '.select().from(schema.products)',
  },
];

function isIdentifierChar(char: string): boolean {
  return (
    char !== '' &&
    (char === '_' ||
      char === '$' ||
      char.toLowerCase() !== char.toUpperCase() ||
      (char >= '0' && char <= '9'))
  );
}

/** True when `needle` occurs in `source` not as the tail of a longer identifier. */
function containsShape(source: string, needle: string): boolean {
  let i = source.indexOf(needle);
  while (i !== -1) {
    if (needle.startsWith('.') || !isIdentifierChar(source.charAt(i - 1))) return true;
    i = source.indexOf(needle, i + 1);
  }
  return false;
}

function collapse(source: string): string {
  return stripComments(source).split(/\s+/).join('');
}

const FILES = readdirSync(REPOSITORIES_DIR)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .sort((a, b) => a.localeCompare(b));

describe('invariant: no full-row read of products outside explicit columns (BAL-592)', () => {
  it('scans a non-empty repository set and sees the guarded read (guards a vacuous pass)', () => {
    expect(FILES.length).toBeGreaterThan(10);
    const experts = collapse(readFileSync(`${REPOSITORIES_DIR}experts.ts`, 'utf8'));
    expect(experts).toContain('product:{columns:{aiHint:false}}');
  });

  it('the scanner recognises each forbidden shape', () => {
    expect(containsShape(collapse('with: { product: true }'), 'product:true')).toBe(true);
    expect(
      containsShape(collapse('db.select()\n  .from(products)'), '.select().from(products)')
    ).toBe(true);
    expect(containsShape(collapse('with: { subproduct: true }'), 'product:true')).toBe(false);
  });

  it.each(FILES)('%s has no full-row products read', (file) => {
    const source = collapse(readFileSync(`${REPOSITORIES_DIR}${file}`, 'utf8'));
    const offenders = FORBIDDEN_SHAPES.filter(({ needle }) => containsShape(source, needle)).map(
      ({ label }) => label
    );
    expect(
      offenders,
      `${file} reads every column of products (${offenders.join(', ')}), leaking the ` +
        `internal ai_hint. Use \`columns: { aiHint: false }\` or an explicit projection.`
    ).toEqual([]);
  });
});
