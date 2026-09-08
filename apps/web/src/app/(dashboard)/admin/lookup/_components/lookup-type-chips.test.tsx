import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { LookupTypeChips } from './lookup-type-chips';

const COUNTS = { all: 6, people: 2, orgs: 2, sessions: 1, requests: 1 };

describe('LookupTypeChips', () => {
  it('renders five chips in order with live counts', () => {
    render(<LookupTypeChips filter="all" counts={COUNTS} onSelect={vi.fn()} />);
    const group = screen.getByRole('group', { name: /filter results by type/i });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([
      'All6',
      'People2',
      'Companies & agencies2',
      'Sessions1',
      'Requests1',
    ]);
  });

  it('marks the active chip aria-pressed=true and others false', () => {
    render(<LookupTypeChips filter="people" counts={COUNTS} onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^People/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('dims and disables a zero-count chip that is not active', () => {
    const counts = { ...COUNTS, sessions: 0 };
    render(<LookupTypeChips filter="all" counts={counts} onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^Sessions/ })).toBeDisabled();
  });

  it('never disables the active chip even at zero count', () => {
    const counts = { ...COUNTS, sessions: 0 };
    render(<LookupTypeChips filter="sessions" counts={counts} onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^Sessions/ })).not.toBeDisabled();
  });

  it('calls onSelect with the clicked filter key', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<LookupTypeChips filter="all" counts={COUNTS} onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: /^Sessions/ }));
    expect(onSelect).toHaveBeenCalledWith('sessions');
  });
});
