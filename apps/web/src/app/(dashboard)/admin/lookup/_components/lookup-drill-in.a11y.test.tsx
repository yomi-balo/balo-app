import { describe, it, expect, vi } from 'vitest';
import { axe } from 'jest-axe';
import { render, waitFor, screen } from '@/test/utils';
import type { LookupSelection } from '../_lib/lookup-view';
import { LookupDrillIn } from './lookup-drill-in';

/**
 * BAL-555 fix round F3 — the WAI-ARIA tabs widget (`LookupDrillInTabs` + the two panels it
 * controls, exercised together via `LookupDrillIn`) is exactly the case for an automated a11y
 * assertion. Follows the established `jest-axe` pattern
 * (`apps/web/src/components/booking/booking-flow-dialog.a11y.test.tsx`) — no new dependency,
 * the matcher is already registered globally in `apps/web/src/test/setup.ts`.
 */

const { mockAction, mockTimelineAction } = vi.hoisted(() => ({
  mockAction: vi.fn(),
  mockTimelineAction: vi.fn(),
}));
vi.mock('../_actions/fetch-lookup-money-block', () => ({
  fetchLookupMoneyBlockAction: mockAction,
}));
vi.mock('../_actions/fetch-lookup-timeline', () => ({
  fetchLookupTimelineAction: mockTimelineAction,
}));

function selection(
  overrides: Partial<LookupSelection> & Pick<LookupSelection, 'type' | 'id'>
): LookupSelection {
  return {
    key: `${overrides.type}:${overrides.id}`,
    title: 'Title',
    sub: 'Sub line',
    publicExpertUsername: null,
    engagementType: null,
    via: 'search',
    ...overrides,
  };
}

describe('LookupDrillIn — accessibility (BAL-555 fix round F3)', () => {
  it('has no violations on the two-tab (credit session) tab shell', async () => {
    mockAction.mockReturnValue(new Promise(() => {}));
    mockTimelineAction.mockResolvedValue({
      ok: true,
      entries: [
        {
          id: 'r1',
          action: 'credit_session.presence_settled',
          summary: 'Settled — 30 min billed',
          occurredAtIso: '2026-06-02T10:15:30.000Z',
          instantKey: '2026-06-02 10:15:30.000000+00',
        },
      ],
      hasEarlier: false,
      earlier: null,
    });

    const { container } = render(
      <LookupDrillIn
        selection={selection({ type: 'credit_session', id: 's1' })}
        onTabSelect={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('Settled — 30 min billed')).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations on the single-tab (labelled section) shape', async () => {
    mockTimelineAction.mockResolvedValue({
      ok: true,
      entries: [],
      hasEarlier: false,
      earlier: null,
    });

    const { container } = render(
      <LookupDrillIn selection={selection({ type: 'company', id: 'co1' })} onTabSelect={vi.fn()} />
    );

    await waitFor(() => expect(mockTimelineAction).toHaveBeenCalled());
    expect(await axe(container)).toHaveNoViolations();
  });
});
