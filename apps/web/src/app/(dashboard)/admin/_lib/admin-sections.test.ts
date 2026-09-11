import { describe, it, expect } from 'vitest';
import { ADMIN_SECTION_ORDER, resolveActiveAdminSection } from './admin-sections';

describe('ADMIN_SECTION_ORDER', () => {
  it('is the design-reference order: Home, Config & catalogue', () => {
    expect(ADMIN_SECTION_ORDER.map((s) => s.key)).toEqual(['home', 'catalogue']);
    expect(ADMIN_SECTION_ORDER.map((s) => s.label)).toEqual(['Home', 'Config & catalogue']);
  });

  it('every row has the expected href', () => {
    expect(ADMIN_SECTION_ORDER.map((s) => s.href)).toEqual(['/admin', '/admin/catalogue']);
  });

  it('key set has no duplicates', () => {
    expect(new Set(ADMIN_SECTION_ORDER.map((s) => s.key)).size).toBe(ADMIN_SECTION_ORDER.length);
  });
});

describe('resolveActiveAdminSection', () => {
  it.each([
    ['/admin', 'home'],
    ['/admin/catalogue', 'catalogue'],
    ['/admin/catalogue/deep', 'catalogue'],
  ] as const)('%s → %s', (pathname, expected) => {
    expect(resolveActiveAdminSection(pathname)).toBe(expected);
  });

  it.each([
    ['/admin/other', null],
    ['/settings/admin', null],
    ['/admin/__proto__', null],
    ['/admin/constructor', null],
    ['/', null],
    ['', null],
    ['/dashboard', null],
  ] as const)('%s → %s', (pathname, expected) => {
    expect(resolveActiveAdminSection(pathname)).toBe(expected);
  });
});
