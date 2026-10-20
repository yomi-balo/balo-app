import { describe, it, expect } from 'vitest';
import { decodeHtmlEntities } from './decode-entities.js';

describe('decodeHtmlEntities', () => {
  it('decodes the entity the model put in a real brief title', () => {
    expect(
      decodeHtmlEntities('National Dental Care — CRM &amp; Marketing Automation Implementation')
    ).toBe('National Dental Care — CRM & Marketing Automation Implementation');
  });

  it.each([
    ['&lt;b&gt;', '<b>'],
    ['&quot;quoted&quot;', '"quoted"'],
    ['it&apos;s', "it's"],
    ['a&nbsp;b', 'a b'],
    ['&#39;', "'"],
    ['&#x2014;', '—'],
    ['&#X2014;', '—'],
  ])('decodes %s', (input, expected) => {
    expect(decodeHtmlEntities(input)).toBe(expected);
  });

  it('decodes in a single pass, so an escaped entity stays an entity', () => {
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
  });

  it.each([
    ['plain & text', 'a bare ampersand'],
    ['&copy;', 'an unknown name'],
    ['&amp', 'a missing semicolon'],
    ['&#0;', 'a NUL reference'],
    ['&#10;', 'a control character'],
    ['&#xD800;', 'a surrogate'],
    ['&#x110000;', 'an out-of-range code point'],
  ])('leaves %s alone (%s)', (input) => {
    expect(decodeHtmlEntities(input)).toBe(input);
  });
});
