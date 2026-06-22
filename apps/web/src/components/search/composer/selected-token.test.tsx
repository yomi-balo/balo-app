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

  it('renders the category line above the label when category is provided', () => {
    render(<SelectedToken label="Field Service" category="Service Cloud" onRemove={vi.fn()} />);
    expect(screen.getByText('Field Service')).toBeInTheDocument();
    expect(screen.getByText('Service Cloud')).toBeInTheDocument();
  });

  it('omits the category line when category is not provided', () => {
    render(<SelectedToken label="Field Service" onRemove={vi.fn()} />);
    expect(screen.getByText('Field Service')).toBeInTheDocument();
    expect(screen.queryByText('Service Cloud')).not.toBeInTheDocument();
  });

  it('omits the category line when category is an empty string', () => {
    render(<SelectedToken label="Field Service" category="" onRemove={vi.fn()} />);
    expect(screen.getByText('Field Service')).toBeInTheDocument();
    expect(screen.queryByText('Service Cloud')).not.toBeInTheDocument();
  });
});
