import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { StepBookedIntroCall } from './step-booked-intro-call';
import * as ics from '../ics';

const mockGetConsentState = vi.hoisted(() => vi.fn());
vi.mock('@/lib/phone/client-sms-consent-actions', () => ({
  getClientSmsConsentStateAction: () => mockGetConsentState(),
  setClientSmsConsentAction: vi.fn(),
}));

function renderStep(overrides: Record<string, unknown> = {}) {
  const onDone = vi.fn();
  render(
    <StepBookedIntroCall
      callKind="intro"
      expertFirstName="Priya"
      startIso="2026-06-05T09:00:00.000Z"
      viewerTimezone="UTC"
      durationMinutes={30}
      provisioned
      joinPath="/meetings/meeting-1/call"
      guestsInvited={0}
      guestInviteFailed={false}
      onDone={onDone}
      {...overrides}
    />
  );
  return { onDone };
}

describe('StepBookedIntroCall', () => {
  beforeEach(() => {
    mockGetConsentState.mockReset();
    mockGetConsentState.mockReturnValue(new Promise(() => undefined));
  });

  it('never gates Back to conversation on the SMS opt-in (loading, then offered)', async () => {
    const user = userEvent.setup();
    const { onDone } = renderStep();
    expect(screen.getByText('Loading text alert options')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to conversation' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Back to conversation' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('offers the opt-in on the intro-call confirmation', async () => {
    mockGetConsentState.mockResolvedValue({ status: 'not_opted_in', verifiedPhone: null });
    renderStep();
    expect(await screen.findByText('Text me when Priya is ready')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to conversation' })).toBeEnabled();
  });

  it('shows the call-shaped confirmation copy, no case verb, no "View case"', () => {
    renderStep();
    expect(screen.getByText("You're booked!")).toBeInTheDocument();
    expect(screen.getByText(/Intro call with Priya/)).toBeInTheDocument();
    expect(screen.queryByText(/View case/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to conversation' })).toBeInTheDocument();
  });

  it('promises the join link only when provisioned, never when it is not', () => {
    renderStep({ provisioned: true });
    expect(screen.getByText('The join link is on its way to your email.')).toBeInTheDocument();

    renderStep({ provisioned: false });
    expect(
      screen.getByText(
        "Your time is held, but your call room isn't ready yet — our team has been alerted."
      )
    ).toBeInTheDocument();
  });

  it('mentions guests when invited, and the warning when the invite partially failed', () => {
    renderStep({ guestsInvited: 2, guestInviteFailed: true });
    expect(screen.getByText(/2 guests invited/)).toBeInTheDocument();
    expect(screen.getByText(/couldn't invite everyone/)).toBeInTheDocument();
  });

  it('"Back to conversation" and "Done" both call onDone', async () => {
    const user = userEvent.setup();
    const { onDone } = renderStep();
    await user.click(screen.getByRole('button', { name: 'Back to conversation' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('builds and downloads the .ics event from "Add to calendar"', () => {
    const spy = vi.spyOn(ics, 'downloadIcsEvent').mockImplementation(() => {});
    renderStep({
      expertFirstName: 'Priya',
      startIso: '2026-06-05T09:00:00.000Z',
      durationMinutes: 30,
    });
    screen.getByRole('button', { name: /Add to calendar/ }).click();
    expect(spy).toHaveBeenCalledWith({
      summary: 'Intro call with Priya',
      startIso: '2026-06-05T09:00:00.000Z',
      durationMinutes: 30,
      filename: 'intro-call.ics',
    });
    spy.mockRestore();
  });

  it('callKind "call" drops "Intro" from the confirmation and the .ics event', () => {
    const spy = vi.spyOn(ics, 'downloadIcsEvent').mockImplementation(() => {});
    renderStep({ callKind: 'call' });
    expect(screen.getByText(/· Call with Priya\./)).toBeInTheDocument();
    expect(screen.queryByText(/intro/i)).not.toBeInTheDocument();
    screen.getByRole('button', { name: /Add to calendar/ }).click();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'Call with Priya', filename: 'call.ics' })
    );
    spy.mockRestore();
  });
});
