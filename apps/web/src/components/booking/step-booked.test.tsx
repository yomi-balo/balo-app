import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import { StepBooked, type StepBookedProps } from './step-booked';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

function renderStep(over: Partial<StepBookedProps> = {}) {
  const onDone = vi.fn();
  const props: StepBookedProps = {
    engagementId: 'engagement-1',
    caseTitle: 'Flow interview loop',
    isNewCase: true,
    expertFirstName: 'Amara',
    startIso: '2026-06-05T09:00:00.000Z',
    viewerTimezone: 'UTC',
    durationMinutes: 30,
    provisioned: true,
    joinPath: '/join/m/meeting-1',
    guestsInvited: 0,
    guestInviteFailed: false,
    onDone,
    ...over,
  };
  const utils = render(<StepBooked {...props} />);
  return { ...utils, onDone };
}

describe('StepBooked', () => {
  it('renders the NEW-case copy variant', () => {
    renderStep({ isNewCase: true });
    expect(screen.getByText(/This started a new case/)).toBeInTheDocument();
    expect(screen.getByText(/Flow interview loop/)).toBeInTheDocument();
  });

  it('renders the ATTACH copy variant', () => {
    renderStep({ isNewCase: false });
    expect(screen.getByText(/Added to your case/)).toBeInTheDocument();
  });

  // ⚠ D2a — the copy must NEVER claim the client's own calendar was updated.
  it('never says the client calendar was updated', () => {
    const { container } = renderStep();
    const text = container.textContent ?? '';
    expect(text).toMatch(/join link is on its way to your email/);
    expect(text.toLowerCase()).not.toContain('calendar invite');
    expect(text.toLowerCase()).not.toContain('added to your calendar');
  });

  // ⚠ M6 — the unprovisioned branch may state only what the platform can honour. There is no
  // repair sweep, no retry job and no provision-on-join, so it must not promise an email or a
  // link "before your call".
  it('promises nothing deliverable when provisioned is false (M6)', () => {
    const { container } = renderStep({ provisioned: false });
    const text = container.textContent ?? '';
    expect(text).toMatch(/our team has been alerted/);
    expect(text).not.toMatch(/on its way to your email/);
    expect(text).not.toMatch(/will be ready before your call/);
  });

  it('shows the guest line only when guests were invited', () => {
    const { rerender } = renderStep({ guestsInvited: 0 });
    expect(screen.queryByText(/guest.*invited/)).not.toBeInTheDocument();

    rerender(
      <StepBooked
        engagementId="engagement-1"
        caseTitle="Flow interview loop"
        isNewCase
        expertFirstName="Amara"
        startIso="2026-06-05T09:00:00.000Z"
        viewerTimezone="UTC"
        durationMinutes={30}
        provisioned
        joinPath="/join/m/meeting-1"
        guestsInvited={2}
        guestInviteFailed={false}
        onDone={vi.fn()}
      />
    );
    expect(screen.getByText(/2 guests invited/)).toBeInTheDocument();
  });

  it('shows the guest-invite-failed note', () => {
    renderStep({ guestInviteFailed: true });
    expect(screen.getByText(/couldn't invite everyone/i)).toBeInTheDocument();
  });

  it('fires onDone from the Done button', async () => {
    const { onDone } = renderStep();
    screen.getByRole('button', { name: 'Done' }).click();
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
