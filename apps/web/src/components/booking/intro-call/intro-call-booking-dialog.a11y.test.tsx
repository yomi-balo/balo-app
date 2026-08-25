import { describe, expect, it, vi } from 'vitest';
import { axe } from 'jest-axe';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import type { BookIntroCallResult } from '@/lib/booking/actions/book-intro-call-types';

/**
 * BAL-283 (plan §13.4, round-1 W14) — the axe sweep over the intro-call dialog's four rendered
 * shapes. The unit suite already pins the individual affordances (sr-only Dialog/Sheet
 * title + description, `aria-current="step"`, `min-h-11` tap targets, `motion-reduce`); this is
 * the WHOLE-TREE check those cannot make, and it mirrors the shipped
 * `booking-flow-dialog.a11y.test.tsx`.
 *
 * ⚠ THE `confirm` SHAPE IS SWEPT **WITH A GUEST ADDED**, deliberately: the guest chip carries
 * its own "Remove {email}" control and the composer's disclosure lines, none of which exist on
 * the empty confirm step — so an empty-state-only sweep would miss exactly the branch that
 * grew the most markup.
 */

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/components/availability', () => ({
  ExpertAvailabilityCalendar: (props: {
    onSlotSelect?: (s: { start: string; end: string; duration: 15 | 30 | 45 | 60 }) => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() =>
          props.onSlotSelect?.({
            start: '2026-06-05T09:00:00.000Z',
            end: '2026-06-05T09:30:00.000Z',
            duration: 30,
          })
        }
      >
        Pick 9am slot
      </button>
    </div>
  ),
}));

const mockBookIntroCallAction = vi.fn<(input: unknown) => Promise<BookIntroCallResult>>();
vi.mock('@/lib/booking/actions/book-intro-call', () => ({
  bookIntroCallAction: (input: unknown) => mockBookIntroCallAction(input),
}));

import { IntroCallBookingDialog } from './intro-call-booking-dialog';

function renderDialog() {
  return render(
    <IntroCallBookingDialog
      open
      onOpenChange={vi.fn()}
      requestId="request-1"
      relationshipId="rel-1"
      expertProfileId="expert-1"
      expertName="Priya Nair"
      expertFirstName="Priya"
      expertInitials="PN"
      requestTitle="CPQ implementation"
      clientCompanyName="Northwind Industrial"
      viewerEmailDomain="northwind.example"
      viewerTimezone="UTC"
      surface="header"
      onBooked={vi.fn()}
      onMessage={vi.fn()}
    />
  );
}

describe('IntroCallBookingDialog — accessibility', () => {
  it('has no violations on the pick_time step', async () => {
    const { baseElement } = renderDialog();
    expect(await axe(baseElement)).toHaveNoViolations();
  });

  it('has no violations on the confirm step, with a guest added', async () => {
    const user = userEvent.setup();
    const { baseElement } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Pick 9am slot' }));

    await user.type(screen.getByLabelText('Guest email address'), 'colleague@northwind.example');
    await user.click(screen.getByRole('button', { name: 'Add guest' }));
    expect(
      screen.getByRole('button', { name: 'Remove colleague@northwind.example' })
    ).toBeVisible();

    expect(await axe(baseElement)).toHaveNoViolations();
  });

  it('has no violations on the booked step', async () => {
    const user = userEvent.setup();
    mockBookIntroCallAction.mockResolvedValue({
      ok: true,
      meetingId: 'meeting-1',
      joinPath: '/join/m/meeting-1',
      provisioned: true,
      scheduledStartIso: '2026-06-05T09:00:00.000Z',
      scheduledEndIso: '2026-06-05T09:30:00.000Z',
      durationMinutes: 30,
      guestsInvited: 1,
      guestInviteFailed: false,
    });
    const { baseElement } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Pick 9am slot' }));
    await user.click(screen.getByRole('button', { name: 'Confirm & book call' }));
    expect(await screen.findByText("You're booked!")).toBeInTheDocument();

    expect(await axe(baseElement)).toHaveNoViolations();
  });

  it('has no violations on the error_hard step (retryable and non-retryable)', async () => {
    const user = userEvent.setup();
    mockBookIntroCallAction.mockResolvedValue({ ok: false, code: 'booking_failed' });
    const retryable = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Pick 9am slot' }));
    await user.click(screen.getByRole('button', { name: 'Confirm & book call' }));
    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    expect(await axe(retryable.baseElement)).toHaveNoViolations();
    retryable.unmount();

    // The `not_permitted` shape renders NO retry button — a different tree, swept separately.
    mockBookIntroCallAction.mockResolvedValue({ ok: false, code: 'not_permitted' });
    const terminal = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Pick 9am slot' }));
    await user.click(screen.getByRole('button', { name: 'Confirm & book call' }));
    expect(await screen.findByText('This request has moved on')).toBeInTheDocument();
    expect(await axe(terminal.baseElement)).toHaveNoViolations();
  });
});
