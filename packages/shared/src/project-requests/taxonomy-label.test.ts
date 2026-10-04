import { describe, it, expect } from 'vitest';
import { MAX_TAXONOMY_LABEL_SCAN, normalizeTaxonomyLabel } from './taxonomy-label';

describe('normalizeTaxonomyLabel', () => {
  it('lowercases', () => {
    expect(normalizeTaxonomyLabel('PARDOT')).toBe('pardot');
  });

  it('strips one leading "salesforce " prefix', () => {
    expect(normalizeTaxonomyLabel('Salesforce Shield')).toBe('shield');
    expect(normalizeTaxonomyLabel('SALESFORCE   CDP')).toBe('cdp');
  });

  it('strips the prefix only once', () => {
    expect(normalizeTaxonomyLabel('Salesforce Salesforce CDP')).toBe('salesforce cdp');
  });

  it('keeps a bare "salesforce"', () => {
    expect(normalizeTaxonomyLabel('Salesforce')).toBe('salesforce');
    expect(normalizeTaxonomyLabel('  SALESFORCE \t')).toBe('salesforce');
  });

  it('does not strip a prefix that is not a whole word', () => {
    expect(normalizeTaxonomyLabel('Salesforcex Cloud')).toBe('salesforcex cloud');
    expect(normalizeTaxonomyLabel('salesforce-cdp')).toBe('salesforce-cdp');
  });

  it('turns "&" into a space-separated "and", with or without surrounding spaces', () => {
    expect(normalizeTaxonomyLabel('Energy & Utilities Cloud')).toBe('energy and utilities cloud');
    expect(normalizeTaxonomyLabel('Energy&Utilities  Cloud')).toBe('energy and utilities cloud');
    expect(normalizeTaxonomyLabel('Energy  &Utilities Cloud')).toBe('energy and utilities cloud');
  });

  it('does not leave a leading or trailing space around a boundary "&"', () => {
    expect(normalizeTaxonomyLabel('& Co')).toBe('and co');
    expect(normalizeTaxonomyLabel('R&')).toBe('r and');
  });

  it('collapses whitespace runs of every kind and trims both ends', () => {
    expect(normalizeTaxonomyLabel('  \tJourney\n\n Builder \r\f\v')).toBe('journey builder');
  });

  it('folds compatibility forms under NFKC (full-width letters, NBSP, ideographic space)', () => {
    expect(normalizeTaxonomyLabel('ＰＡＲＤＯＴ')).toBe('pardot');
    expect(normalizeTaxonomyLabel('Sales Cloud')).toBe('sales cloud');
    expect(normalizeTaxonomyLabel('Ｓａｌｅｓｆｏｒｃｅ　Shield')).toBe('shield');
  });

  it('returns an empty string for empty or whitespace-only input', () => {
    expect(normalizeTaxonomyLabel('')).toBe('');
    expect(normalizeTaxonomyLabel(' \t\n ')).toBe('');
  });

  it('keeps punctuation other than "&"', () => {
    expect(normalizeTaxonomyLabel('Force.com')).toBe('force.com');
    expect(normalizeTaxonomyLabel('Messaging for In-App and Web')).toBe(
      'messaging for in-app and web'
    );
  });

  it(`reads at most ${MAX_TAXONOMY_LABEL_SCAN} code points`, () => {
    expect(normalizeTaxonomyLabel('a'.repeat(MAX_TAXONOMY_LABEL_SCAN * 4))).toBe(
      'a'.repeat(MAX_TAXONOMY_LABEL_SCAN)
    );
    // Whitespace counts toward the bound: the word after it is never reached.
    const padded = `${' '.repeat(MAX_TAXONOMY_LABEL_SCAN)}shield`;
    expect(normalizeTaxonomyLabel(padded)).toBe('');
  });

  it('counts code points, not UTF-16 units', () => {
    const astral = '😀'.repeat(MAX_TAXONOMY_LABEL_SCAN + 5);
    expect([...normalizeTaxonomyLabel(astral)]).toHaveLength(MAX_TAXONOMY_LABEL_SCAN);
  });
});
