import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { track, CALL_NOW_EVENTS } from '@/lib/analytics';
import type { CaseCallNowView } from '@/lib/call-now/call-now-types';
import { CallNowEntry } from './call-now-entry';

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';

const CLIENT_BUTTON: CaseCallNowView = {
  entry: 'button',
  calleeLabel: 'Amara',
  onlineBadge: true,
  calleeTimeZone: null,
  confirm: {
    kind: 'client_terms',
    engagementId: ENGAGEMENT_ID,
    expertProfileId: 'p-1',
    calleeOnline: true,
    rateLine: 'A$125.00/min · 15-minute minimum',
    inPlaceCandidate: { meetingId: 'm-1', scheduledStartIso: '2026-11-19T10:00:00.000Z' },
    bookInPage: true,
  },
};

const EXPERT_BUTTON: CaseCallNowView = {
  entry: 'button',
  calleeLabel: 'Northwind Industrial',
  onlineBadge: false,
  calleeTimeZone: null,
  confirm: { kind: 'expert_notice', engagementId: ENGAGEMENT_ID },
};

describe('CallNowEntry', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders an outline Call now button named for the callee', () => {
    render(<CallNowEntry callNow={CLIENT_BUTTON} lens="client" onCallNow={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Call Amara now' });
    expect(button).toHaveTextContent('Call now');
    expect(button).toHaveClass('min-h-11');
  });

  it('tracks the click with presence and today-booking facts, then opens the confirm', async () => {
    const onCallNow = vi.fn();
    render(<CallNowEntry callNow={CLIENT_BUTTON} lens="client" onCallNow={onCallNow} />);

    await userEvent.click(screen.getByRole('button', { name: 'Call Amara now' }));

    expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.ENTRY_CLICKED, {
      lens: 'client',
      presence: 'online',
      has_booking_today: true,
    });
    expect(onCallNow).toHaveBeenCalledTimes(1);
  });

  it('reports an offline callee with no booking today', async () => {
    const callNow: CaseCallNowView = {
      ...CLIENT_BUTTON,
      confirm: {
        ...(CLIENT_BUTTON.confirm as Extract<
          NonNullable<CaseCallNowView['confirm']>,
          { kind: 'client_terms' }
        >),
        calleeOnline: false,
        inPlaceCandidate: null,
      },
    };
    render(<CallNowEntry callNow={callNow} lens="client" onCallNow={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Call Amara now' }));
    expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.ENTRY_CLICKED, {
      lens: 'client',
      presence: 'offline',
      has_booking_today: false,
    });
  });

  it('tracks the expert arm with the expert lens', async () => {
    render(<CallNowEntry callNow={EXPERT_BUTTON} lens="expert" onCallNow={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Call Northwind Industrial now' }));
    expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.ENTRY_CLICKED, {
      lens: 'expert',
      presence: 'unknown',
      has_booking_today: false,
    });
  });

  it('shows the busy line and no button', () => {
    render(
      <CallNowEntry
        callNow={{ ...CLIENT_BUTTON, entry: 'busy', confirm: null }}
        lens="client"
        onCallNow={vi.fn()}
      />
    );
    expect(screen.getByText('Amara is in another call')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the callee’s local time on the outside-hours line', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-19T00:30:00.000Z'));
    try {
      render(
        <CallNowEntry
          callNow={{
            ...CLIENT_BUTTON,
            entry: 'outside_hours',
            calleeTimeZone: 'Australia/Sydney',
            confirm: null,
          }}
          lens="client"
          onCallNow={vi.fn()}
        />
      );
      const expected = new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'Australia/Sydney',
      }).format(new Date('2026-11-19T00:30:00.000Z'));
      expect(
        screen.getByText(`It’s ${expected} for Amara — book a time instead`)
      ).toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['absent', null],
    ['unknown', 'Not/AZone'],
  ])('renders nothing on outside_hours when the zone is %s', (_label, calleeTimeZone) => {
    const { container } = render(
      <CallNowEntry
        callNow={{ ...CLIENT_BUTTON, entry: 'outside_hours', calleeTimeZone, confirm: null }}
        lens="client"
        onCallNow={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
