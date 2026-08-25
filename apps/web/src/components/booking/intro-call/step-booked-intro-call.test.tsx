import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { StepBookedIntroCall } from './step-booked-intro-call';
import * as ics from '../ics';

function renderStep(overrides: Record<string, unknown> = {}) {
  const onDone = vi.fn();
  render(
    <StepBookedIntroCall
      expertFirstName="Priya"
      startIso="2026-06-05T09:00:00.000Z"
      viewerTimezone="UTC"
      durationMinutes={30}
      provisioned
      joinPath="/join/m/meeting-1"
      guestsInvited={0}
      guestInviteFailed={false}
      onDone={onDone}
      {...overrides}
    />
  );
  return { onDone };
}

describe('StepBookedIntroCall', () => {
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
});
