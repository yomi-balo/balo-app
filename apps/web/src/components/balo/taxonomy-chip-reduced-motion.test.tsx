import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useReducedMotion } from 'motion/react';
import { TaxonomyChip } from './taxonomy-chip';

/**
 * Real `motion/react`: `useReducedMotion()` is null on the server and true on the client; a
 * `whileTap` present in one and absent in the other makes motion add `tabindex` to only one.
 */
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => true) };
});

function markup(): string {
  return renderToStaticMarkup(
    <TaxonomyChip label="Apex" name="Apex" selected onToggle={vi.fn()} />
  );
}

describe('TaxonomyChip reduced motion', () => {
  it('server-renders the same markup whether or not reduced motion is known yet', () => {
    vi.mocked(useReducedMotion).mockReturnValue(null);
    const unresolved = markup();
    vi.mocked(useReducedMotion).mockReturnValue(true);
    expect(markup()).toBe(unresolved);
    expect(unresolved).toContain('Apex');
  });
});
