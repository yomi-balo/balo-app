import { describe, expect, it, vi } from 'vitest';
import { axe } from 'jest-axe';
import { render } from '@/test/utils';
import type { SavedCard } from '@/components/billing/top-up/types';
import { RemoveCardConfirm } from './remove-card-confirm';
import { cardRemovalUncoveredMessage } from './messages';

const CARD: SavedCard = {
  brand: 'visa',
  last4: '4242',
  expMonth: 8,
  expYear: 2028,
  mandateActive: true,
};

/**
 * BAL-474 owner ruling D10.6 — the remove-card dialog stays accessibility-clean in its blocked
 * state. The alert dialog renders in a portal, so axe runs over `document.body`, not the render
 * container.
 */
describe('RemoveCardConfirm — accessibility (D10.6 blocked state)', () => {
  function renderBlocked(reason: string) {
    return render(
      <RemoveCardConfirm
        card={CARD}
        mode="keep_going"
        open
        onOpenChange={vi.fn()}
        pending={false}
        onConfirm={vi.fn()}
        blockedReason={reason}
      />
    );
  }

  it('has no violations with the figure copy', async () => {
    renderBlocked(
      cardRemovalUncoveredMessage({
        topUpNeededMinor: 123_450,
        reservedBookingCount: 2,
        companyName: 'Northwind Industrial',
      })
    );
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('has no violations with the large copy and the company fallback', async () => {
    renderBlocked(
      cardRemovalUncoveredMessage({
        topUpNeededMinor: 1_250_000,
        reservedBookingCount: 1,
        companyName: null,
      })
    );
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
