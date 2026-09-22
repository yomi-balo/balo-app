import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import { CHECKLIST_ITEMS } from '@/lib/constants/expert-checklist';
import type { ChecklistStatus } from '@/lib/actions/expert-checklist';
import { SetupContextBar } from './setup-context-bar';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

/** Every item done except the ones named. */
function statusWithOpen(...open: Array<keyof ChecklistStatus['items']>): ChecklistStatus {
  const items = {
    profile: true,
    phone: true,
    rate: true,
    calendar: true,
    availability: true,
    payouts: true,
  };
  for (const key of open) items[key] = false;
  const completedCount = Object.values(items).filter(Boolean).length;
  return {
    items,
    completedCount,
    allComplete: completedCount === CHECKLIST_ITEMS.length,
    rateCents: 10000,
    calendarNeedsReconnect: false,
  } as ChecklistStatus;
}

function dotStates(): Array<string | null> {
  return Array.from(document.querySelectorAll('[data-state]')).map((dot) =>
    dot.getAttribute('data-state')
  );
}

describe('SetupContextBar', () => {
  it('counts against the real number of checklist items, never a hard-coded total', () => {
    render(
      <SetupContextBar activeSetupStep="payouts" checklistStatus={statusWithOpen('payouts')} />
    );

    expect(
      screen.getByText(
        `Step ${CHECKLIST_ITEMS.length} of ${CHECKLIST_ITEMS.length} — Set up payouts`
      )
    ).toBeInTheDocument();
  });

  it('⚠ marks the unfinished current step as current, not complete — the last dot must not look done', () => {
    render(
      <SetupContextBar activeSetupStep="payouts" checklistStatus={statusWithOpen('payouts')} />
    );

    expect(dotStates()).toEqual([
      'complete',
      'complete',
      'complete',
      'complete',
      'complete',
      'current',
    ]);
  });

  it('keeps a completed step complete when it is the one being revisited', () => {
    render(<SetupContextBar activeSetupStep="rate" checklistStatus={statusWithOpen('payouts')} />);

    expect(dotStates()).toEqual([
      'complete',
      'complete',
      'complete',
      'complete',
      'complete',
      'upcoming',
    ]);
  });

  it('shows untouched steps as upcoming', () => {
    render(
      <SetupContextBar
        activeSetupStep="profile"
        checklistStatus={statusWithOpen('profile', 'calendar', 'payouts')}
      />
    );

    expect(dotStates()).toEqual([
      'current',
      'complete',
      'complete',
      'upcoming',
      'complete',
      'upcoming',
    ]);
    expect(screen.getByText('Step 1 of 6 — Complete your profile')).toBeInTheDocument();
  });

  it('summarises progress for assistive tech', () => {
    render(
      <SetupContextBar activeSetupStep="payouts" checklistStatus={statusWithOpen('payouts')} />
    );

    expect(screen.getByRole('img', { name: '5 of 6 steps complete' })).toBeInTheDocument();
  });
});
