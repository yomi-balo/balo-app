import { describe, it, expect } from 'vitest';
import { MAX_UNMATCHED_LABEL_LENGTH, normalizeTaxonomyLabel } from '@balo/shared/project-requests';
import { PRODUCT_CATEGORIES, SALESFORCE_PRODUCT_ALIASES } from './salesforce-taxonomy';
import { flattenProductAliasSeed, slugify } from './taxonomy-seed';

/**
 * BAL-592 AC7 — seed integrity of the Salesforce alias constant, under the SAME normaliser the
 * brief-parse resolver keys its lookup with. Postgres only guards `lower(alias)` per vertical;
 * this is where "the same label" is enforced in full.
 */

const PRODUCT_NAMES = PRODUCT_CATEGORIES.flatMap(([, , names]) => names);
const PRODUCT_SLUGS = PRODUCT_NAMES.map(slugify);
const ALIAS_ROWS = flattenProductAliasSeed(SALESFORCE_PRODUCT_ALIASES);
const HINTS = Object.entries(SALESFORCE_PRODUCT_ALIASES).flatMap(([slug, seed]) =>
  seed.hint === undefined ? [] : [{ slug, hint: seed.hint }]
);

/** Postgres `char_length` counts code points, not UTF-16 units. */
const charLength = (value: string): number => [...value].length;

describe('PRODUCT_CATEGORIES', () => {
  it('slugifies to unique product slugs', () => {
    expect(new Set(PRODUCT_SLUGS).size).toBe(PRODUCT_SLUGS.length);
  });

  it('slugifies the names the alias constant is keyed by', () => {
    expect(slugify('Energy & Utilities Cloud')).toBe('energy-utilities-cloud');
    expect(slugify('Salesforce Platform')).toBe('salesforce-platform');
    expect(slugify('CRM Analytics')).toBe('crm-analytics');
  });
});

describe('SALESFORCE_PRODUCT_ALIASES', () => {
  it('is non-empty (guards every check below from passing vacuously)', () => {
    expect(ALIAS_ROWS.length).toBeGreaterThan(100);
    expect(HINTS.length).toBeGreaterThan(0);
  });

  it('is keyed only by seeded product slugs', () => {
    const known = new Set(PRODUCT_SLUGS);
    const unknown = Object.keys(SALESFORCE_PRODUCT_ALIASES).filter((slug) => !known.has(slug));
    expect(unknown).toEqual([]);
  });

  it('never repeats a product name or alias under normalizeTaxonomyLabel', () => {
    const owners = new Map<string, string[]>();
    const claim = (label: string, owner: string): void => {
      const key = normalizeTaxonomyLabel(label);
      owners.set(key, [...(owners.get(key) ?? []), owner]);
    };
    for (const name of PRODUCT_NAMES) claim(name, `product name "${name}"`);
    for (const row of ALIAS_ROWS) claim(row.alias, `${row.slug} alias "${row.alias}"`);

    const collisions = [...owners.entries()].filter(([, claimants]) => claimants.length > 1);
    expect(collisions).toEqual([]);
  });

  it('keeps every alias within product_alias_shape (1–80 chars, no angle brackets)', () => {
    const violations = ALIAS_ROWS.filter(
      ({ alias }) =>
        charLength(alias) < 1 ||
        charLength(alias) > 80 ||
        alias.includes('<') ||
        alias.includes('>') ||
        /[\r\n]/.test(alias)
    );
    expect(violations).toEqual([]);
  });

  it('keeps every alias matchable as a model label', () => {
    // A longer alias could never equal a model label, which is capped at this length; an alias
    // that normalises to nothing could never be looked up.
    const violations = ALIAS_ROWS.filter(
      ({ alias }) =>
        alias.length > MAX_UNMATCHED_LABEL_LENGTH || normalizeTaxonomyLabel(alias) === ''
    );
    expect(violations).toEqual([]);
  });

  it('keeps every hint within product_ai_hint_shape (1–240 chars, no angle brackets)', () => {
    const violations = HINTS.filter(
      ({ hint }) =>
        charLength(hint) < 1 ||
        charLength(hint) > 240 ||
        hint.includes('<') ||
        hint.includes('>') ||
        /[\r\n]/.test(hint)
    );
    expect(violations).toEqual([]);
  });

  it('keeps the brief-prompt delimiters out of every alias and hint', () => {
    const delimiters = ['\n', '\r', '|', '[', ']'];
    const offenders = [
      ...ALIAS_ROWS.map(({ alias }) => alias),
      ...HINTS.map(({ hint }) => hint),
    ].filter((text) => delimiters.some((d) => text.includes(d)));
    expect(offenders).toEqual([]);
  });

  it('keeps commas out of aliases (hints may carry them)', () => {
    expect(ALIAS_ROWS.filter(({ alias }) => alias.includes(','))).toEqual([]);
  });
});
