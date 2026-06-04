import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => true) };
});

import { SelectedToken } from './selected-token';

describe('SelectedToken', () => {
  it('renders the label and an accessible remove button', () => {
    render(<SelectedToken label="Agentforce" onRemove={vi.fn()} />);
    expect(screen.getByText('Agentforce')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Agentforce' })).toBeInTheDocument();
  });

  it('fires onRemove when the × is clicked', async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();
    render(<SelectedToken label="CPQ" onRemove={onRemove} />);
    await user.click(screen.getByRole('button', { name: 'Remove CPQ' }));
    expect(onRemove).toHaveBeenCalledOnce();
  });
});
