import { describe, expect, it } from 'vitest';
import { render, screen } from '@/test/utils';
import { MIN_MEETING_MINUTES } from '@balo/shared/meetings';
import { BillingLine, CancellationLine, CANCELLATION_LINE_COPY } from './billing-line';

describe('BillingLine', () => {
  it('interpolates the minimum from MIN_MEETING_MINUTES, never a hardcoded literal', () => {
    render(<BillingLine />);
    expect(
      screen.getByText(
        `Charged only for time used · ${MIN_MEETING_MINUTES}-minute minimum applies.`
      )
    ).toBeInTheDocument();
  });

  // D4c — no rate is rendered anywhere in the flow.
  it('renders no currency symbol and no "/min" anywhere in the tree', () => {
    const { container } = render(<BillingLine />);
    const text = container.textContent ?? '';
    expect(text).not.toContain('A$');
    expect(text).not.toContain('$');
    expect(text).not.toContain('/min');
  });
});

describe('CancellationLine', () => {
  it('renders the exact verbatim copy — no countdown, no fee schedule', () => {
    render(<CancellationLine />);
    // R6-C4 — pinned against the FULL approved literal, and the retired sentence must be gone.
    expect(CANCELLATION_LINE_COPY).toBe('Free to cancel until anyone joins the call.');
    expect(screen.getByText('Free to cancel until anyone joins the call.')).toBeInTheDocument();
    expect(screen.queryByText(/scheduled start time/)).not.toBeInTheDocument();
  });
});
