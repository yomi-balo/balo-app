import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { StepBooked, type StepBookedProps } from './step-booked';
import * as ics from './ics';
import { toast } from 'sonner';
import { CALENDAR_EVENTS, track } from '@/lib/analytics';
import { CALENDAR_TAB_BLOCKED_COPY } from './add-to-calendar-actions';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const mockPush = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));
const mockGetConsentState = vi.hoisted(() => vi.fn());
vi.mock('@/lib/phone/client-sms-consent-actions', () => ({
  getClientSmsConsentStateAction: () => mockGetConsentState(),
  setClientSmsConsentAction: vi.fn(),
}));

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
    joinPath: '/meetings/meeting-1/call',
    guestsInvited: 0,
    guestInviteFailed: false,
    onDone,
    ...over,
  };
  const utils = render(<StepBooked {...props} />);
  return { ...utils, onDone };
}

describe('StepBooked', () => {
  beforeEach(() => {
    mockGetConsentState.mockReset();
    mockGetConsentState.mockReturnValue(new Promise(() => undefined));
  });

  it('never gates Done or View case on the SMS opt-in (still loading)', async () => {
    const user = userEvent.setup();
    const { onDone } = renderStep();
    expect(screen.getByText('Loading text alert options')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'View case' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('keeps Done enabled while the SMS opt-in is on offer', async () => {
    mockGetConsentState.mockResolvedValue({ status: 'not_opted_in', verifiedPhone: null });
    renderStep();
    expect(await screen.findByText('Text me when Amara is ready')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'View case' })).toBeEnabled();
  });

  it('renders the NEW-case copy variant', () => {
    renderStep({ isNewCase: true });
    expect(screen.getByText(/This started a new case/)).toBeInTheDocument();
    expect(screen.getByText(/Flow interview loop/)).toBeInTheDocument();
  });

  it('renders the ATTACH copy variant', () => {
    renderStep({ isNewCase: false });
    expect(screen.getByText(/Added to your case/)).toBeInTheDocument();
  });

  it('points a hand-off at "Invite a colleague" (draft copy, pending MJ)', () => {
    renderStep();

    expect(
      screen.getByText(
        'Passing this call to a colleague? Choose "Invite a colleague" on the case so they get their own join link.'
      )
    ).toBeInTheDocument();
  });

  // ⚠ D2a — the copy must NEVER claim the client's own calendar was updated.
  it('never says the client calendar was updated', () => {
    const { container } = renderStep();
    const text = container.textContent ?? '';
    expect(text).toMatch(/join link is on its way to your email/);
    expect(text.toLowerCase()).not.toContain('calendar invite');
    expect(text.toLowerCase()).not.toContain('added to your calendar');
  });

  // ⚠ the unprovisioned branch's promise holds because a provisioning failure is captured to
  // Sentry, raises the `meeting.unprovisioned` admin alert, and the venue repair job provisions
  // the room automatically — so it must not ALSO promise an email or a link "before your call",
  // which nothing here delivers.
  it('promises nothing deliverable when provisioned is false', () => {
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
        joinPath="/meetings/meeting-1/call"
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

  it('closes the flow and opens the case from "View case"', () => {
    const { onDone } = renderStep();
    screen.getByRole('button', { name: 'View case' }).click();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/cases/engagement-1');
  });

  it('builds and downloads the .ics event from "Other calendar app"', () => {
    const spy = vi.spyOn(ics, 'downloadIcsEvent').mockImplementation(() => {});
    renderStep({
      expertFirstName: 'Amara',
      startIso: '2026-06-05T09:00:00.000Z',
      durationMinutes: 30,
    });
    screen.getByRole('button', { name: /Other calendar app/ }).click();
    expect(spy).toHaveBeenCalledWith({
      summary: 'Consultation with Amara',
      startIso: '2026-06-05T09:00:00.000Z',
      durationMinutes: 30,
      filename: 'consultation.ics',
    });
    spy.mockRestore();
  });

  it('tracks both calendar choices on the booking confirmation surface', () => {
    const spy = vi.spyOn(ics, 'downloadIcsEvent').mockImplementation(() => {});
    const open = vi.spyOn(globalThis, 'open').mockReturnValue({} as Window);
    renderStep();
    screen.getByRole('button', { name: /Add to Google Calendar/ }).click();
    screen.getByRole('button', { name: /Other calendar app/ }).click();
    expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.ADD_OPTION_CLICKED, {
      option: 'google',
      surface: 'booking_confirmation',
    });
    expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.ADD_OPTION_CLICKED, {
      option: 'ics',
      surface: 'booking_confirmation',
    });
    spy.mockRestore();
    open.mockRestore();
  });

  it('says so, and stays put, when the browser blocks the new tab', () => {
    vi.spyOn(globalThis, 'open').mockReturnValue(null);
    const assign = vi.fn();
    vi.spyOn(globalThis, 'location', 'get').mockReturnValue({ assign } as unknown as Location);
    renderStep();
    screen.getByRole('button', { name: /Add to Google Calendar/ }).click();
    expect(toast.error).toHaveBeenCalledWith(CALENDAR_TAB_BLOCKED_COPY);
    expect(assign).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('opens a pre-filled Google event in a new tab, with no provider href in the DOM', () => {
    const open = vi.spyOn(globalThis, 'open').mockReturnValue({} as Window);
    const { container } = renderStep({
      expertFirstName: 'Amara',
      startIso: '2026-06-05T09:00:00.000Z',
      durationMinutes: 30,
    });
    expect(container.innerHTML).not.toContain('calendar.google.com');
    screen.getByRole('button', { name: /Add to Google Calendar/ }).click();
    const [url, target] = open.mock.calls[0] ?? [];
    expect(target).toBe('_blank');
    const parsed = new URL(String(url));
    expect(parsed.hostname).toBe('calendar.google.com');
    expect(parsed.searchParams.get('text')).toBe('Consultation with Amara');
    expect(parsed.searchParams.get('dates')).toBe('20260605T090000Z/20260605T093000Z');
    open.mockRestore();
  });
});
