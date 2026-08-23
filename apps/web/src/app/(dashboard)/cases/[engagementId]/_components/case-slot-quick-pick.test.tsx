import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@/test/utils';
import {
  jsonResponse,
  okAvailabilityBody,
  AVAILABILITY_EXPERT_ID,
} from '@/test/fixtures/availability';
import type { BookingFlowDialogProps, BookingFlowExpert } from '@/components/booking';
import { CaseSlotQuickPick } from './case-slot-quick-pick';

// This file scopes to the strip's OWN rendering + selection wiring, not BookingFlowDialog's
// internals (covered by booking-flow-dialog.test.tsx) — stub it and assert on the props it's
// mounted with.
const { mockDialogProps } = vi.hoisted(() => ({ mockDialogProps: vi.fn() }));
vi.mock('@/components/booking', () => ({
  BookingFlowDialog: (props: BookingFlowDialogProps) => {
    mockDialogProps(props);
    return <div data-testid="booking-dialog-stub">{props.open ? 'open' : 'closed'}</div>;
  },
}));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  mockDialogProps.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const EXPERT: BookingFlowExpert = {
  expertProfileId: AVAILABILITY_EXPERT_ID,
  name: 'Amara Okafor',
  firstName: 'Amara',
  initials: 'AO',
  avatarUrl: null,
  partyLabel: 'CloudPeak',
  verified: false,
  availableForWork: true,
};

const DEFAULT_PROPS = {
  engagementId: 'engagement-1',
  caseTitle: 'Flow interview loop',
  consultationCount: 2,
  openedAtIso: '2026-06-12T09:00:00Z',
  expertProfileId: AVAILABILITY_EXPERT_ID,
  expert: EXPERT,
  viewerEmailDomain: null,
};

describe('CaseSlotQuickPick', () => {
  it('renders nothing while the availability fetch is pending (never a bare spinner)', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { container } = render(<CaseSlotQuickPick {...DEFAULT_PROPS} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing on not_configured', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        expertProfileId: AVAILABILITY_EXPERT_ID,
        status: 'not_configured',
        expertTimezone: 'UTC',
        days: 7,
        slots: [],
      })
    );
    const { container } = render(<CaseSlotQuickPick {...DEFAULT_PROPS} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders nothing when the calendar is unreachable (503)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, {}));
    const { container } = render(<CaseSlotQuickPick {...DEFAULT_PROPS} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders up to 3 quick-pick pills when slots are ready', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        okAvailabilityBody({
          slots: [
            { start: '2026-06-05T09:00:00.000Z', end: '2026-06-05T10:00:00.000Z', maxDuration: 60 },
            { start: '2026-06-05T11:00:00.000Z', end: '2026-06-05T11:30:00.000Z', maxDuration: 30 },
            { start: '2026-06-06T09:00:00.000Z', end: '2026-06-06T09:15:00.000Z', maxDuration: 15 },
            { start: '2026-06-06T13:00:00.000Z', end: '2026-06-06T14:00:00.000Z', maxDuration: 60 },
          ],
        })
      )
    );
    render(<CaseSlotQuickPick {...DEFAULT_PROPS} />);
    const pills = await screen.findAllByRole('button');
    expect(pills).toHaveLength(3);
  });

  it('opens the wrapper directly at the fixed case with the tapped slot pre-filled', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        okAvailabilityBody({
          slots: [
            { start: '2026-06-05T09:00:00.000Z', end: '2026-06-05T10:00:00.000Z', maxDuration: 60 },
          ],
        })
      )
    );
    render(<CaseSlotQuickPick {...DEFAULT_PROPS} />);
    const [pill] = await screen.findAllByRole('button');
    expect(pill).toBeDefined();
    if (pill) await user.click(pill);

    expect(screen.getByTestId('booking-dialog-stub')).toHaveTextContent('open');
    const lastCall = mockDialogProps.mock.calls.at(-1)?.[0] as BookingFlowDialogProps;
    expect(lastCall.source).toBe('case_quick_pick');
    expect(lastCall.entry).toEqual({
      mode: 'fixed_case',
      fixedCase: {
        engagementId: 'engagement-1',
        title: 'Flow interview loop',
        consultationCount: 2,
        openedAtIso: '2026-06-12T09:00:00Z',
      },
      presetSlot: {
        startIso: '2026-06-05T09:00:00.000Z',
        endIso: '2026-06-05T10:00:00.000Z',
        durationMinutes: 60,
      },
    });
    // D4a #3 — no case-choice section anywhere in this entry; nothing here even threads a
    // companyId/eligible-company list, confirming the wrapper never needs one for this arm.
  });

  // UX-2 (BAL-400 round 2) — the caller-supplied domain must reach the dialog verbatim, not a
  // hardcoded `null` (the exact bug this finding named).
  it('forwards the caller-supplied viewerEmailDomain to the wrapper, never a hardcoded null', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        okAvailabilityBody({
          slots: [
            { start: '2026-06-05T09:00:00.000Z', end: '2026-06-05T10:00:00.000Z', maxDuration: 60 },
          ],
        })
      )
    );
    render(<CaseSlotQuickPick {...DEFAULT_PROPS} viewerEmailDomain="northwind.com" />);
    const [pill] = await screen.findAllByRole('button');
    expect(pill).toBeDefined();
    if (pill) await user.click(pill);

    const lastCall = mockDialogProps.mock.calls.at(-1)?.[0] as BookingFlowDialogProps;
    expect(lastCall.viewerEmailDomain).toBe('northwind.com');
  });
});
