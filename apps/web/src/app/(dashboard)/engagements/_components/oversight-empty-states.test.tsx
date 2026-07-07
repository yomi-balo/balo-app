import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { FilteredEmptyState, ZeroEmptyState } from './oversight-empty-states';

describe('FilteredEmptyState', () => {
  it('renders the stalled invitation as a good outcome, not an absence', () => {
    render(<FilteredEmptyState filter="stalled" onClear={vi.fn()} />);
    expect(screen.getByText('Nothing has gone quiet')).toBeInTheDocument();
    expect(screen.getByText(/silent for 14\+ days/i)).toBeInTheDocument();
  });

  it('renders the in-review invitation copy', () => {
    render(<FilteredEmptyState filter="in_review" onClear={vi.fn()} />);
    expect(screen.getByText('Nothing waiting on a client')).toBeInTheDocument();
  });

  it('renders the completed invitation copy', () => {
    render(<FilteredEmptyState filter="completed" onClear={vi.fn()} />);
    expect(screen.getByText('No completed engagements yet')).toBeInTheDocument();
  });

  it('fires onClear from the single Back-to-in-flight action', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    render(<FilteredEmptyState filter="cancelled" onClear={onClear} />);
    await user.click(screen.getByRole('button', { name: /back to in flight/i }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe('ZeroEmptyState', () => {
  it('explains how engagements come to exist and links to the pipeline', () => {
    render(<ZeroEmptyState />);
    expect(screen.getByText('No engagements in flight yet')).toBeInTheDocument();
    expect(screen.getByText(/client accepts a proposal/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /go to the pipeline/i });
    expect(link).toHaveAttribute('href', '/projects?lens=admin');
  });
});
