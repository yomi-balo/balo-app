import { describe, it, expect } from 'vitest';
import { resolveExpertUpNextSurface } from './expert-up-next-surface';
import type { UpNextRowView } from './up-next-view-types';

const ROW = {} as UpNextRowView;

describe('resolveExpertUpNextSurface (BAL-566 R2)', () => {
  it('rows + incomplete setup -> card (bookings win)', () => {
    expect(resolveExpertUpNextSurface({ kind: 'ready', rows: [ROW] }, { allComplete: false })).toBe(
      'card'
    );
  });

  it('[] + incomplete setup -> ghost', () => {
    expect(resolveExpertUpNextSurface({ kind: 'ready', rows: [] }, { allComplete: false })).toBe(
      'ghost'
    );
  });

  it('[] + null checklist (read failed) -> ghost', () => {
    expect(resolveExpertUpNextSurface({ kind: 'ready', rows: [] }, null)).toBe('ghost');
  });

  it('[] + complete setup -> card (Empty state)', () => {
    expect(resolveExpertUpNextSurface({ kind: 'ready', rows: [] }, { allComplete: true })).toBe(
      'card'
    );
  });

  it('error + incomplete setup -> card (the error state, never the ghost)', () => {
    expect(resolveExpertUpNextSurface({ kind: 'error' }, { allComplete: false })).toBe('card');
  });

  it('error + null checklist -> card', () => {
    expect(resolveExpertUpNextSurface({ kind: 'error' }, null)).toBe('card');
  });

  it('rows + complete setup -> card', () => {
    expect(resolveExpertUpNextSurface({ kind: 'ready', rows: [ROW] }, { allComplete: true })).toBe(
      'card'
    );
  });
});
