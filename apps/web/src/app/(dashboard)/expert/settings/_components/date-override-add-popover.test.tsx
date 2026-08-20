import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DateRange } from 'react-day-picker';
import { DateOverrideAddPopover } from './date-override-add-popover';
import type { AvailabilityConflictReportDto } from '../_types/availability-conflict';

// ── Mocks ────────────────────────────────────────────────────────

const mockTrack = vi.fn();
vi.mock('@/lib/analytics', () => ({
  track: (...args: unknown[]) => mockTrack(...args),
  AVAILABILITY_EVENTS: {
    OVERRIDE_CONFLICT_DETECTED: 'availability_override_conflict_detected',
    OVERRIDE_CONFLICT_RESOLVED: 'availability_override_conflict_resolved',
  },
}));

// A minimal fake calendar: two buttons each select a fixed single-day range, driving the
// real popover's state machine without needing to interact with the real day-picker grid.
// The second button exists purely so the Q4 race test can switch the selection WHILE a
// check for the first is still in flight.
vi.mock('@/components/ui/calendar', () => ({
  Calendar: ({ onSelect }: { onSelect: (range: DateRange) => void }) => (
    <>
      <button
        type="button"
        onClick={() => onSelect({ from: new Date('2026-12-24T00:00:00'), to: undefined })}
      >
        pick-2026-12-24
      </button>
      <button
        type="button"
        onClick={() => onSelect({ from: new Date('2026-12-25T00:00:00'), to: undefined })}
      >
        pick-2026-12-25
      </button>
    </>
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const EXPERT_ID = 'profile-1';

function report(
  overrides: Partial<AvailabilityConflictReportDto> = {}
): AvailabilityConflictReportDto {
  return {
    conflictCount: 2,
    durationDays: 1,
    timezone: 'Australia/Sydney',
    truncated: false,
    conflicts: [
      {
        consultationId: 'c1',
        startAt: '2026-12-24T03:00:00.000Z',
        endAt: '2026-12-24T04:00:00.000Z',
        clientCompanyName: 'Northwind Industrial',
      },
    ],
    ...overrides,
  };
}

async function openPopover(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: /add time off/i }));
}

async function pickADate(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'pick-2026-12-24' }));
}

describe('DateOverrideAddPopover', () => {
  it('zero conflicts: calls onCreate immediately, never mounts the warning, fires no analytics', async () => {
    const onCreate = vi.fn().mockResolvedValue(true);
    const onCheckConflicts = vi
      .fn()
      .mockResolvedValue({ ...report(), conflictCount: 0, conflicts: [] });
    const user = userEvent.setup();

    render(
      <DateOverrideAddPopover
        onCreate={onCreate}
        onCheckConflicts={onCheckConflicts}
        expertProfileId={EXPERT_ID}
      />
    );
    await openPopover(user);
    await pickADate(user);
    await waitFor(() => expect(onCheckConflicts).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /block these dates/i }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        startDate: '2026-12-24',
        endDate: '2026-12-24',
        label: undefined,
      })
    );
    expect(screen.queryByText(/already booked/)).not.toBeInTheDocument();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('onCheckConflicts resolving null: behaves the same as zero conflicts (fail-open)', async () => {
    const onCreate = vi.fn().mockResolvedValue(true);
    const onCheckConflicts = vi.fn().mockResolvedValue(null);
    const user = userEvent.setup();

    render(
      <DateOverrideAddPopover
        onCreate={onCreate}
        onCheckConflicts={onCheckConflicts}
        expertProfileId={EXPERT_ID}
      />
    );
    await openPopover(user);
    await pickADate(user);
    await waitFor(() => expect(onCheckConflicts).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /block these dates/i }));

    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('conflictCount > 0: does NOT call onCreate, mounts the warning, tracks OVERRIDE_CONFLICT_DETECTED', async () => {
    const onCreate = vi.fn().mockResolvedValue(true);
    const onCheckConflicts = vi.fn().mockResolvedValue(report());
    const user = userEvent.setup();

    render(
      <DateOverrideAddPopover
        onCreate={onCreate}
        onCheckConflicts={onCheckConflicts}
        expertProfileId={EXPERT_ID}
      />
    );
    await openPopover(user);
    await pickADate(user);
    await waitFor(() => expect(onCheckConflicts).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /block these dates/i }));

    await waitFor(() =>
      expect(screen.getByText('2 sessions are already booked in these dates')).toBeInTheDocument()
    );
    expect(onCreate).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith('availability_override_conflict_detected', {
      conflict_count: 2,
      duration_days: 1,
      expert_profile_id: EXPERT_ID,
    });
  });

  it('"Block dates anyway": calls onCreate once; on success tracks blocked_anyway', async () => {
    const onCreate = vi.fn().mockResolvedValue(true);
    const onCheckConflicts = vi.fn().mockResolvedValue(report());
    const user = userEvent.setup();

    render(
      <DateOverrideAddPopover
        onCreate={onCreate}
        onCheckConflicts={onCheckConflicts}
        expertProfileId={EXPERT_ID}
      />
    );
    await openPopover(user);
    await pickADate(user);
    await waitFor(() => expect(onCheckConflicts).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /block these dates/i }));
    await waitFor(() => screen.getByRole('button', { name: /block dates anyway/i }));

    await user.click(screen.getByRole('button', { name: /block dates anyway/i }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(mockTrack).toHaveBeenCalledWith('availability_override_conflict_resolved', {
      resolution: 'blocked_anyway',
      conflict_count: 2,
      expert_profile_id: EXPERT_ID,
    });
  });

  it('onCreate returning false: no blocked_anyway tracked, the warning stays mounted', async () => {
    const onCreate = vi.fn().mockResolvedValue(false);
    const onCheckConflicts = vi.fn().mockResolvedValue(report());
    const user = userEvent.setup();

    render(
      <DateOverrideAddPopover
        onCreate={onCreate}
        onCheckConflicts={onCheckConflicts}
        expertProfileId={EXPERT_ID}
      />
    );
    await openPopover(user);
    await pickADate(user);
    await waitFor(() => expect(onCheckConflicts).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /block these dates/i }));
    await waitFor(() => screen.getByRole('button', { name: /block dates anyway/i }));

    await user.click(screen.getByRole('button', { name: /block dates anyway/i }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(mockTrack).not.toHaveBeenCalledWith(
      'availability_override_conflict_resolved',
      expect.objectContaining({ resolution: 'blocked_anyway' })
    );
    expect(screen.getByText('2 sessions are already booked in these dates')).toBeInTheDocument();
  });

  it('"Choose other dates": tracks abandoned and returns to the calendar view, range preserved', async () => {
    const onCreate = vi.fn();
    const onCheckConflicts = vi.fn().mockResolvedValue(report());
    const user = userEvent.setup();

    render(
      <DateOverrideAddPopover
        onCreate={onCreate}
        onCheckConflicts={onCheckConflicts}
        expertProfileId={EXPERT_ID}
      />
    );
    await openPopover(user);
    await pickADate(user);
    await waitFor(() => expect(onCheckConflicts).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /block these dates/i }));
    await waitFor(() => screen.getByRole('button', { name: /choose other dates/i }));

    await user.click(screen.getByRole('button', { name: /choose other dates/i }));

    expect(mockTrack).toHaveBeenCalledWith('availability_override_conflict_resolved', {
      resolution: 'abandoned',
      conflict_count: 2,
      expert_profile_id: EXPERT_ID,
    });
    // Back on the calendar view — the fake calendar button is visible again.
    expect(screen.getByRole('button', { name: 'pick-2026-12-24' })).toBeInTheDocument();
  });

  it('closing the popover from the warning view fires abandoned exactly once', async () => {
    const onCreate = vi.fn();
    const onCheckConflicts = vi.fn().mockResolvedValue(report());
    const user = userEvent.setup();

    render(
      <div>
        <DateOverrideAddPopover
          onCreate={onCreate}
          onCheckConflicts={onCheckConflicts}
          expertProfileId={EXPERT_ID}
        />
        <button type="button">outside</button>
      </div>
    );
    await openPopover(user);
    await pickADate(user);
    await waitFor(() => expect(onCheckConflicts).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /block these dates/i }));
    await waitFor(() => screen.getByRole('button', { name: /block dates anyway/i }));

    // Radix's Popover treats an outside click as a dismiss regardless of current focus,
    // which is a more robust close trigger for this test than Escape (whose handling can
    // depend on which element currently has focus).
    await user.click(screen.getByRole('button', { name: 'outside' }));

    const resolvedCalls = mockTrack.mock.calls.filter(
      (call) => call[0] === 'availability_override_conflict_resolved'
    );
    expect(resolvedCalls).toHaveLength(1);
    expect(resolvedCalls[0]?.[1]).toEqual({
      resolution: 'abandoned',
      conflict_count: 2,
      expert_profile_id: EXPERT_ID,
    });
  });

  // ── C1 — a rejected conflict check must fail OPEN, not brick the button ────────────────

  it('onCheckConflicts REJECTING fails open: onCreate IS called and no analytics fires (C1)', async () => {
    const onCreate = vi.fn().mockResolvedValue(true);
    const onCheckConflicts = vi.fn().mockRejectedValue(new Error('Unauthorized'));
    const user = userEvent.setup();

    render(
      <DateOverrideAddPopover
        onCreate={onCreate}
        onCheckConflicts={onCheckConflicts}
        expertProfileId={EXPERT_ID}
      />
    );
    await openPopover(user);
    await pickADate(user);
    await waitFor(() => expect(onCheckConflicts).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /block these dates/i }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        startDate: '2026-12-24',
        endDate: '2026-12-24',
        label: undefined,
      })
    );
    expect(mockTrack).not.toHaveBeenCalled();
    // The block committed and the popover closed/reset — `pending` did not strand the
    // trigger disabled forever (the exact bug: previously the rejection propagated straight
    // out of `handleSubmit`'s `await`, so neither `onCreate` nor `setPending(false)` ever
    // ran, and `reset()` didn't clear `pending` either).
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /add time off/i })).toBeInTheDocument()
    );
  });

  // ── R1 — a submit inside the 250ms debounce window must still run the check ────────────

  it('submitting IMMEDIATELY after picking a date still runs the conflict check (R1)', async () => {
    const onCreate = vi.fn().mockResolvedValue(true);
    const onCheckConflicts = vi.fn().mockResolvedValue(report());
    const user = userEvent.setup();

    render(
      <DateOverrideAddPopover
        onCreate={onCreate}
        onCheckConflicts={onCheckConflicts}
        expertProfileId={EXPERT_ID}
      />
    );
    await openPopover(user);
    await pickADate(user);
    // Deliberately NO `waitFor(() => onCheckConflicts called)` here — submitting immediately,
    // inside the 250ms debounce window, is the exact regression: before R1 the debounce had
    // not yet populated `requestRef`, so the submit read `null` and took D10's fail-open
    // branch, committing the block with NO conflict check ever issued.
    await user.click(screen.getByRole('button', { name: /block these dates/i }));

    await waitFor(() =>
      expect(screen.getByText('2 sessions are already booked in these dates')).toBeInTheDocument()
    );
    expect(onCreate).not.toHaveBeenCalled();
    expect(onCheckConflicts).toHaveBeenCalledWith({
      startDate: '2026-12-24',
      endDate: '2026-12-24',
    });
  });

  // ── R2 — focus must not land on the destructive button ─────────────────────────────────

  it('a repeated Enter that begins on "Block these dates" cannot also activate "Block dates anyway" after the view swaps (R2)', async () => {
    const onCreate = vi.fn().mockResolvedValue(true);
    const onCheckConflicts = vi.fn().mockResolvedValue(report());
    const user = userEvent.setup();

    render(
      <DateOverrideAddPopover
        onCreate={onCreate}
        onCheckConflicts={onCheckConflicts}
        expertProfileId={EXPERT_ID}
      />
    );
    await openPopover(user);
    await pickADate(user);
    await waitFor(() => expect(onCheckConflicts).toHaveBeenCalled());

    screen.getByRole('button', { name: /block these dates/i }).focus();
    // Simulates OS key-repeat: the SAME physical Enter press that activates "Block these
    // dates" keeps sending keydowns after the view swaps underneath it. Before R2, focus
    // landed on "Block dates anyway", so a repeat activated that too — detecting and
    // resolving a conflict in one keypress with no human having read a word of it. After R2,
    // focus lands on the (non-interactive) heading, so the repeat is inert there.
    await user.keyboard('{Enter>3/}');

    await waitFor(() =>
      expect(screen.getByText('2 sessions are already booked in these dates')).toBeInTheDocument()
    );
    expect(onCreate).not.toHaveBeenCalled();
  });

  // ── Q1 — one conflict decision must emit exactly ONE resolution event ──────────────────

  it('dismissing WHILE "Block dates anyway" is in flight fires exactly ONE resolved event (Q1)', async () => {
    let resolveCreate: ((created: boolean) => void) | undefined;
    const onCreate = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCreate = resolve;
        })
    );
    const onCheckConflicts = vi.fn().mockResolvedValue(report());
    const user = userEvent.setup();

    render(
      <div>
        <DateOverrideAddPopover
          onCreate={onCreate}
          onCheckConflicts={onCheckConflicts}
          expertProfileId={EXPERT_ID}
        />
        <button type="button">outside</button>
      </div>
    );
    await openPopover(user);
    await pickADate(user);
    await waitFor(() => expect(onCheckConflicts).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /block these dates/i }));
    await waitFor(() => screen.getByRole('button', { name: /block dates anyway/i }));

    // Start the confirm — `onCreate`'s promise is held open under our control, so `pending`
    // stays true while the dismiss below is attempted.
    await user.click(screen.getByRole('button', { name: /block dates anyway/i }));

    // Dismiss the popover WHILE the confirm is still in flight. Before the Q1 guard, this
    // fired a SECOND `'abandoned'` resolution on top of the eventual `'blocked_anyway'`.
    await user.click(screen.getByRole('button', { name: 'outside' }));

    resolveCreate?.(true);
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));

    const resolvedCalls = mockTrack.mock.calls.filter(
      (call) => call[0] === 'availability_override_conflict_resolved'
    );
    expect(resolvedCalls).toHaveLength(1);
    expect(resolvedCalls[0]?.[1]).toEqual({
      resolution: 'blocked_anyway',
      conflict_count: 2,
      expert_profile_id: EXPERT_ID,
    });
  });

  // ── R5 — dismissing mid-confirm, then a FAILED create, must still resolve once ─────────

  it('dismissing WHILE "Block dates anyway" is in flight, and the create then FAILS, still fires exactly ONE abandoned event (R5)', async () => {
    let resolveCreate: ((created: boolean) => void) | undefined;
    const onCreate = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCreate = resolve;
        })
    );
    const onCheckConflicts = vi.fn().mockResolvedValue(report());
    const user = userEvent.setup();

    render(
      <div>
        <DateOverrideAddPopover
          onCreate={onCreate}
          onCheckConflicts={onCheckConflicts}
          expertProfileId={EXPERT_ID}
        />
        <button type="button">outside</button>
      </div>
    );
    await openPopover(user);
    await pickADate(user);
    await waitFor(() => expect(onCheckConflicts).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /block these dates/i }));
    await waitFor(() => screen.getByRole('button', { name: /block dates anyway/i }));

    await user.click(screen.getByRole('button', { name: /block dates anyway/i }));

    // Dismiss WHILE the confirm is still in flight — before R5, this raced the eventual
    // `false` outcome into total silence: neither the dismiss (guarded by `pending`) nor the
    // failed confirm (no `created` branch for `false`) ever tracked a resolution.
    await user.click(screen.getByRole('button', { name: 'outside' }));

    resolveCreate?.(false);
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));

    await waitFor(() => {
      const resolvedCalls = mockTrack.mock.calls.filter(
        (call) => call[0] === 'availability_override_conflict_resolved'
      );
      expect(resolvedCalls).toHaveLength(1);
    });
    const resolvedCalls = mockTrack.mock.calls.filter(
      (call) => call[0] === 'availability_override_conflict_resolved'
    );
    expect(resolvedCalls[0]?.[1]).toEqual({
      resolution: 'abandoned',
      conflict_count: 2,
      expert_profile_id: EXPERT_ID,
    });
  });

  // ── Q4 — the stale-token race proceeds UNCHECKED, not merely "discarded" ───────────────

  it('a stale-token race proceeds UNCHECKED for the submitted range, ignoring the eventual (conflict-laden) stale response (Q4)', async () => {
    let resolveA: ((v: AvailabilityConflictReportDto | null) => void) | undefined;
    const promiseA = new Promise<AvailabilityConflictReportDto | null>((resolve) => {
      resolveA = resolve;
    });
    const onCreate = vi.fn().mockResolvedValue(true);
    const onCheckConflicts = vi
      .fn()
      .mockImplementationOnce(() => promiseA) // range A's check — held open under our control
      .mockResolvedValue(report()); // range B's check — armed, but its result is never read
    const user = userEvent.setup();

    render(
      <DateOverrideAddPopover
        onCreate={onCreate}
        onCheckConflicts={onCheckConflicts}
        expertProfileId={EXPERT_ID}
      />
    );
    await openPopover(user);
    await user.click(screen.getByRole('button', { name: 'pick-2026-12-24' }));
    await waitFor(() => expect(onCheckConflicts).toHaveBeenCalledTimes(1));

    // Submit for range A WHILE its check is still pending — synchronously captures
    // `requestRef.current` (token 1, `promiseA`) as `handleSubmit`'s `inFlight`.
    await user.click(screen.getByRole('button', { name: /block these dates/i }));

    // A NEWER selection re-arms `requestRef.current` with a FRESH token while the submit
    // above is still awaiting `promiseA` — this is what makes token 1 stale.
    await user.click(screen.getByRole('button', { name: 'pick-2026-12-25' }));
    await waitFor(() => expect(onCheckConflicts).toHaveBeenCalledTimes(2));

    // Range A's now-STALE response finally arrives — carrying REAL conflicts, which the
    // stale-token guard must discard rather than surface as a warning.
    resolveA?.(report());

    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    // Proceeds UNCHECKED, for the range that was live AT SUBMIT TIME (A) — not B, and not
    // gated by A's conflict report, which arrived too late to count.
    expect(onCreate).toHaveBeenCalledWith({
      startDate: '2026-12-24',
      endDate: '2026-12-24',
      label: undefined,
    });
    expect(mockTrack).not.toHaveBeenCalledWith(
      'availability_override_conflict_detected',
      expect.anything()
    );
  });
});
