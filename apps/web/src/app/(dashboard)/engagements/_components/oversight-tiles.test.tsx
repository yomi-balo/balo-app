import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { OversightCounts } from '@/lib/engagements/oversight-row';
import { OversightTiles } from './oversight-tiles';

vi.mock('motion/react', () => ({
  motion: new Proxy(
    {},
    {
      get:
        (_t, tag: string) =>
        ({ children, ...rest }: { children?: React.ReactNode } & Record<string, unknown>) => {
          const { initial, animate, transition, ...domProps } = rest;
          void initial;
          void animate;
          void transition;
          const Tag = tag as keyof React.JSX.IntrinsicElements;
          return <Tag {...domProps}>{children}</Tag>;
        },
    }
  ),
}));

function counts(overrides: Partial<OversightCounts> = {}): OversightCounts {
  return { active: 3, inReview: 2, stalled: 1, completed: 4, cancelled: 0, ...overrides };
}

describe('OversightTiles', () => {
  it('renders all five status tiles with their counts', () => {
    render(<OversightTiles counts={counts()} filter="in_flight" onSelect={vi.fn()} />);
    const active = screen.getByRole('button', { name: /active/i });
    expect(within(active).getByText('3')).toBeInTheDocument();
    expect(
      within(screen.getByRole('button', { name: /in review/i })).getByText('2')
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('button', { name: /stalled/i })).getByText('1')
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('button', { name: /completed/i })).getByText('4')
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('button', { name: /cancelled/i })).getByText('0')
    ).toBeInTheDocument();
  });

  it('selects a tile filter on click', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<OversightTiles counts={counts()} filter="in_flight" onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: /stalled/i }));
    expect(onSelect).toHaveBeenCalledWith('stalled');
  });

  it('returns to the in-flight default when the selected tile is clicked again', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<OversightTiles counts={counts()} filter="active" onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: /active/i }));
    expect(onSelect).toHaveBeenCalledWith('in_flight');
  });

  it('tints the active + in-review tiles as included in the in-flight default', () => {
    render(<OversightTiles counts={counts()} filter="in_flight" onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /active/i })).toHaveClass('bg-primary/5');
    expect(screen.getByRole('button', { name: /in review/i })).toHaveClass('bg-warning/5');
    // A non-in-flight tile keeps the default card surface (no included tint).
    expect(screen.getByRole('button', { name: /completed/i })).toHaveClass('bg-card');
    // No single tile is fully selected in the composite default.
    expect(screen.getByRole('button', { name: /active/i })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('marks the selected tile pressed with its selected surface', () => {
    render(<OversightTiles counts={counts()} filter="stalled" onSelect={vi.fn()} />);
    const stalled = screen.getByRole('button', { name: /stalled/i });
    expect(stalled).toHaveAttribute('aria-pressed', 'true');
    expect(stalled).toHaveClass('bg-destructive/10');
  });
});
