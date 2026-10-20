import { describe, it, expect } from 'vitest';

import { relationshipIsOpened } from './client-visibility';

describe('relationshipIsOpened', () => {
  it('is false for a track that never opened', () => {
    expect(relationshipIsOpened({ openedAt: null })).toBe(false);
  });

  it('is true once the track has opened', () => {
    expect(relationshipIsOpened({ openedAt: new Date('2026-01-01T00:00:00.000Z') })).toBe(true);
  });

  it('fails closed when a projection omitted the column', () => {
    expect(relationshipIsOpened({} as unknown as { openedAt: Date | null })).toBe(false);
  });
});
