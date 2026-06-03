import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

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
});
