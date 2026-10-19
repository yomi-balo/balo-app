import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { useReducedMotion } from 'motion/react';

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => true) };
});

import { ProductChip } from './product-chip';

describe('ProductChip', () => {
  it('renders the label and exposes the accessible name', () => {
    render(
      <ProductChip label="Agentforce" name="Agentforce" selected={false} onToggle={vi.fn()} />
    );
    expect(screen.getByRole('button', { name: 'Agentforce' })).toBeInTheDocument();
  });

  it('reflects the selected state via aria-pressed', () => {
    render(<ProductChip label="Agentforce" name="Agentforce" selected onToggle={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Agentforce' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('fires onToggle when clicked', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<ProductChip label="CPQ" name="CPQ" selected={false} onToggle={onToggle} />);
    await user.click(screen.getByRole('button', { name: 'CPQ' }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('server-renders the same markup whether or not reduced motion is known yet', () => {
    // `useReducedMotion()` is null on the server and true on the client; a `whileTap` that is
    // present in one and absent in the other makes motion add `tabindex` to only one of them.
    vi.mocked(useReducedMotion).mockReturnValueOnce(null);
    const unresolved = renderToStaticMarkup(
      <ProductChip label="Agentforce" name="Agentforce" selected onToggle={vi.fn()} />
    );
    vi.mocked(useReducedMotion).mockReturnValueOnce(true);
    const reduced = renderToStaticMarkup(
      <ProductChip label="Agentforce" name="Agentforce" selected onToggle={vi.fn()} />
    );
    expect(reduced).toBe(unresolved);
  });
});
