import { describe, it, expect } from 'vitest';
import {
  RESPONSIBILITIES_MAX_HTML,
  RESPONSIBILITIES_TOO_LONG,
  responsibilitiesFieldSchema,
  responsibilitiesPreview,
  responsibilitiesTextLength,
} from './work-history-responsibilities';

describe('responsibilitiesTextLength', () => {
  it('counts visible characters, not markup', () => {
    expect(responsibilitiesTextLength('<ul><li><strong>Led</strong></li></ul>')).toBe(3);
  });

  it('counts a legacy plain-text value by its own characters', () => {
    expect(responsibilitiesTextLength('A & B')).toBe(5);
  });

  it('is 0 for nothing at all', () => {
    expect(responsibilitiesTextLength(null)).toBe(0);
  });
});

describe('responsibilitiesFieldSchema', () => {
  it('accepts 1,000 visible characters even when the markup is longer', () => {
    expect(
      responsibilitiesFieldSchema.safeParse(`<p><strong>${'a'.repeat(1000)}</strong></p>`).success
    ).toBe(true);
  });

  it('refuses 1,001 visible characters with the shared message', () => {
    const result = responsibilitiesFieldSchema.safeParse(`<p>${'a'.repeat(1001)}</p>`);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(RESPONSIBILITIES_TOO_LONG);
  });

  it('refuses raw HTML past the payload bound even when little of it is visible', () => {
    const bloated = `<p>${'<strong></strong>'.repeat(RESPONSIBILITIES_MAX_HTML / 17 + 1)}x</p>`;
    expect(bloated.length).toBeGreaterThan(RESPONSIBILITIES_MAX_HTML);
    expect(responsibilitiesFieldSchema.safeParse(bloated).success).toBe(false);
  });

  it('accepts an empty value — the field is optional', () => {
    expect(responsibilitiesFieldSchema.safeParse('').success).toBe(true);
  });
});

describe('responsibilitiesPreview', () => {
  it('reduces editor HTML to its visible text', () => {
    expect(responsibilitiesPreview('<ul><li><strong>Led</strong> delivery</li></ul>')).toBe(
      'Led delivery'
    );
  });

  it('shows a legacy plain-text value as written, even one containing angle brackets', () => {
    expect(responsibilitiesPreview('  a <b> c  ')).toBe('a <b> c');
  });

  it('is empty for nothing at all', () => {
    expect(responsibilitiesPreview(undefined)).toBe('');
  });
});
