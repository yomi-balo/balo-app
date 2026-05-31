import { describe, it, expect } from 'vitest';
import { HEADLINE_TEMPLATES, renderHeadline } from './headlines.js';

describe('renderHeadline', () => {
  it('substitutes all three slots', () => {
    const result = renderHeadline('{years}+ years {cloud} for {industry}', {
      years: 8,
      cloud: 'Sales Cloud',
      industry: 'healthcare',
    });
    expect(result).toBe('8+ years Sales Cloud for healthcare');
  });

  it('handles a slot that appears multiple times', () => {
    const result = renderHeadline('{cloud} • {cloud} expert', {
      years: 3,
      cloud: 'Data Cloud',
      industry: 'retail',
    });
    expect(result).toBe('Data Cloud • Data Cloud expert');
  });

  it('leaves no leftover placeholders for every shipped template', () => {
    for (const template of HEADLINE_TEMPLATES) {
      const rendered = renderHeadline(template, {
        years: 12,
        cloud: 'Service Cloud',
        industry: 'financial services',
      });
      expect(rendered).not.toMatch(/\{[a-z]+\}/);
    }
  });

  it('ships a non-empty template pool', () => {
    expect(HEADLINE_TEMPLATES.length).toBeGreaterThanOrEqual(20);
  });
});
