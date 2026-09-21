import { describe, expect, it, vi } from 'vitest';
import { axe } from 'jest-axe';
import { render } from '@/test/utils';
import type { BookingFlowExpert, BookingContext } from './types';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/use-auth-modal', () => ({
  useAuthModal: () => ({ open: vi.fn(), close: vi.fn(), isOpen: false }),
}));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/components/availability', () => ({
  ExpertAvailabilityCalendar: () => <div>Calendar</div>,
}));
vi.mock('@/components/balo/rich-text-editor', () => ({
  RichTextEditor: ({ placeholder }: { placeholder?: string }) => (
    <textarea aria-label="What you'd like to discuss" placeholder={placeholder} />
  ),
}));
vi.mock('@/lib/booking/actions/book-consultation', () => ({ bookConsultationAction: vi.fn() }));
vi.mock('@/lib/booking/actions/refetch-open-cases', () => ({
  refetchOpenCasesAction: vi.fn().mockResolvedValue({ ok: false }),
}));
vi.mock('@/lib/booking/actions/refetch-booking-context', () => ({
  refetchBookingContextAction: vi.fn().mockResolvedValue({ ok: false }),
}));

import { BookingFlowDialog } from './booking-flow-dialog';
import { StepBooked } from './step-booked';
import { FundingSetupPanel } from './booking-error-panels';

const EXPERT: BookingFlowExpert = {
  expertProfileId: 'expert-1',
  name: 'Amara Okafor',
  firstName: 'Amara',
  initials: 'AO',
  avatarUrl: null,
  partyLabel: 'CloudPeak',
  verified: true,
  availableForWork: true,
};

const SINGLE_COMPANY: BookingContext = {
  arm: 'single_company',
  company: { id: 'company-1', name: 'Northwind Industrial', logoUrl: null },
  openCases: [],
  resolvedCaseCount: 0,
};

describe('BookingFlowDialog — accessibility', () => {
  it('has no violations on the new-case confirm shape', async () => {
    const { container } = render(
      <BookingFlowDialog
        open
        onClose={vi.fn()}
        expert={EXPERT}
        source="case_quick_pick"
        entry={{
          mode: 'fixed_case',
          fixedCase: {
            engagementId: 'engagement-9',
            title: 'Flow interview loop',
            consultationCount: 2,
            openedAtIso: '2026-06-01T00:00:00.000Z',
          },
          presetSlot: {
            startIso: '2026-06-05T09:00:00.000Z',
            endIso: '2026-06-05T09:30:00.000Z',
            durationMinutes: 30,
          },
        }}
        viewerEmailDomain={null}
        onMessage={vi.fn()}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations on the onboarding-routing state', async () => {
    const { container } = render(
      <BookingFlowDialog
        open
        onClose={vi.fn()}
        expert={EXPERT}
        source="profile"
        entry={{ mode: 'chooser', context: { arm: 'onboarding_required' } }}
        viewerEmailDomain={null}
        onMessage={vi.fn()}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations on the pick-time (Step 1) shape', async () => {
    const { container } = render(
      <BookingFlowDialog
        open
        onClose={vi.fn()}
        expert={EXPERT}
        source="profile"
        entry={{ mode: 'chooser', context: SINGLE_COMPANY }}
        viewerEmailDomain={null}
        onMessage={vi.fn()}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('StepBooked — accessibility', () => {
  it('has no violations on the booked state', async () => {
    const { container } = render(
      <StepBooked
        engagementId="engagement-1"
        caseTitle="Flow interview loop"
        isNewCase
        expertFirstName="Amara"
        startIso="2026-06-05T09:00:00.000Z"
        viewerTimezone="UTC"
        durationMinutes={30}
        provisioned
        joinPath="/meetings/meeting-1/call"
        guestsInvited={1}
        guestInviteFailed={false}
        onDone={vi.fn()}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

/**
 * BAL-478 — the funding pre-condition's panel, both capability arms. Rendered directly (the
 * `ExpertAvailabilityCalendar` mock in this file has no slot-pick affordance to drive a real
 * submit through to `error_funding`, unlike `booking-flow-dialog.test.tsx`'s interaction-level
 * mock), matching this file's own `StepBooked` precedent above.
 */
describe('FundingSetupPanel — accessibility', () => {
  it('has no violations on the self-serve (MANAGE_BILLING) arm', async () => {
    const { container } = render(
      <FundingSetupPanel canManageBilling onManageBilling={vi.fn()} onClose={vi.fn()} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations on the billing-admins-notified arm', async () => {
    const { container } = render(
      <FundingSetupPanel canManageBilling={false} onManageBilling={vi.fn()} onClose={vi.fn()} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
