import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ListingStatusLine } from './listing-status-line';
import type { ChecklistStatus } from '@/lib/actions/expert-checklist';

function buildStatus(overrides: Partial<ChecklistStatus> = {}): ChecklistStatus {
  return {
    items: {
      profile: true,
      phone: true,
      rate: true,
      calendar: true,
      availability: true,
      payouts: true,
    },
    completedCount: 6,
    allComplete: true,
    rateCents: 313,
    ...overrides,
  };
}

describe('ListingStatusLine (BAL-414, D11)', () => {
  it('confirms the expert is listed when allComplete is true', () => {
    render(<ListingStatusLine status={buildStatus()} />);
    expect(screen.getByText("You're appearing in search.")).toBeInTheDocument();
  });

  it('is invitation-framed, not absence-framed, when not listed', () => {
    render(
      <ListingStatusLine
        status={buildStatus({
          allComplete: false,
          completedCount: 5,
          items: {
            profile: true,
            phone: true,
            rate: true,
            calendar: true,
            availability: true,
            payouts: false,
          },
        })}
      />
    );
    expect(
      screen.getByText("You're not appearing in search yet — 1 item to go.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/no .* yet/i)).not.toBeInTheDocument();
  });

  it('pluralises the item count correctly', () => {
    render(
      <ListingStatusLine
        status={buildStatus({
          allComplete: false,
          completedCount: 4,
          items: {
            profile: true,
            phone: true,
            rate: true,
            calendar: false,
            availability: true,
            payouts: false,
          },
        })}
      />
    );
    expect(
      screen.getByText("You're not appearing in search yet — 2 items to go.")
    ).toBeInTheDocument();
  });

  it('derives the count from ChecklistStatus alone — no extra props needed', () => {
    const status = buildStatus({
      allComplete: false,
      completedCount: 0,
      items: {
        profile: false,
        phone: false,
        rate: false,
        calendar: false,
        availability: false,
        payouts: false,
      },
    });
    render(<ListingStatusLine status={status} />);
    expect(
      screen.getByText("You're not appearing in search yet — 6 items to go.")
    ).toBeInTheDocument();
  });
});
