import { describe, it, expect } from 'vitest';
import { creditsChipIsInScope } from './credits-chip-scope';
import type { NavContext } from './nav-registry';

describe('creditsChipIsInScope', () => {
  it('is in scope for a company workspace', () => {
    const context: NavContext = { workspaceType: 'company', capabilities: [] };
    expect(creditsChipIsInScope(context)).toBe(true);
  });

  it('is NOT in scope for an expert workspace', () => {
    const context: NavContext = { workspaceType: 'expert', capabilities: [] };
    expect(creditsChipIsInScope(context)).toBe(false);
  });
});
