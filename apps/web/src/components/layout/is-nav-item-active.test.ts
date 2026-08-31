import { describe, it, expect } from 'vitest';
import { isNavItemActive } from './is-nav-item-active';

describe('isNavItemActive (BAL-495/501)', () => {
  it('/dashboard is an EXACT match only — a nested path is not active', () => {
    expect(isNavItemActive('/dashboard', '/dashboard')).toBe(true);
    expect(isNavItemActive('/dashboard/x', '/dashboard')).toBe(false);
  });

  it('every other href matches exactly or by prefix-with-separator', () => {
    expect(isNavItemActive('/projects', '/projects')).toBe(true);
    expect(isNavItemActive('/projects/req-1', '/projects')).toBe(true);
    // A separator is required — a route that merely starts with the same characters must not
    // match (e.g. a hypothetical '/projects-archive' page must not light up 'Projects').
    expect(isNavItemActive('/projects-archive', '/projects')).toBe(false);
  });

  it('an unrelated pathname is never active', () => {
    expect(isNavItemActive('/messages', '/projects')).toBe(false);
  });
});
