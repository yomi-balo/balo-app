import type { SavedCard } from '@/components/billing/top-up/types';
import type { RefusedFundingView } from './funding-disposition';

export const SAVED_CARD: SavedCard = {
  brand: 'visa',
  last4: '4242',
  expMonth: 8,
  expYear: 2030,
  mandateActive: false,
};

/** A billing manager's refusal on the setup arm, active company, no card on file. */
export function refusedView(overrides: Partial<RefusedFundingView> = {}): RefusedFundingView {
  return {
    kind: 'refused',
    arm: 'setup',
    canManageBilling: true,
    company: { id: 'company-1', name: 'Northwind', isActive: true },
    firstTime: true,
    topUpNeededMinor: null,
    reservedBookingCount: null,
    suggestedTopUpMinor: 30_000,
    wallet: {
      savedCard: null,
      lowBalanceFigures: { topupReloadMinor: 10_000, topupThresholdMinor: 2_000 },
    },
    ...overrides,
  };
}
