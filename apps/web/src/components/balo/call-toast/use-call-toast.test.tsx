import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { CALL_NOW_EVENTS, track } from '@/lib/analytics';
import { takeAnswerIntent } from '@/lib/call-now/answer-intent';
import type { IncomingCallView } from '@/lib/call-now/call-now-types';
import type { BellNotification } from '../notification-arrival';
import { useCallToast } from './use-call-toast';
import type { MissedToastView, RingingToastView } from './call-toast-model';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  readIncoming: vi.fn(),
  readRing: vi.fn(),
  decline: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  captureException: vi.fn(),
  requestPermission: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.captureException }));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('@/lib/call-now/actions/read-incoming-call', () => ({
  readIncomingCallAction: mocks.readIncoming,
}));
vi.mock('@/lib/call-now/actions/decline-call-now-ring', () => ({
  declineCallNowRingAction: mocks.decline,
}));
vi.mock('@/app/(call)/meetings/[meetingId]/call/_actions/read-call-now-ring', () => ({
  readCallNowRingAction: mocks.readRing,
}));
vi.mock('@/lib/call-now/notification-permission', () => ({
  requestCallNotificationPermission: mocks.requestPermission,
}));

const NOW = Date.parse('2026-11-19T10:00:00.000Z');
const RING_MS = 30_000;

function ring(overrides: Partial<IncomingCallView> = {}): IncomingCallView {
  return {
    ringId: 'ring-1',
    meetingId: 'meeting-1',
    engagementId: 'eng-1',
    lens: 'client',
    callerLabel: 'Sandy',
    caseTitle: 'Flow migration',
    rateLine: null,
    expiresAtIso: new Date(NOW + RING_MS).toISOString(),
    startedAtIso: new Date(NOW).toISOString(),
    awaitsAnswer: true,
    joinPath: '/meetings/meeting-1/call',
    serverNowIso: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function row(
  id: string,
  event: string,
  overrides: Partial<BellNotification> = {},
  ringId: string | null = 'ring-1'
): BellNotification {
  return {
    id,
    event,
    title: id,
    body: null,
    actionUrl: event === 'call.ringing' ? '/meetings/meeting-1/call' : '/cases/eng-1',
    readAt: null,
    createdAt: new Date(NOW + 1_000).toISOString(),
    call: { ringId, callerUserId: 'u1', callerLabel: 'Sandy', startedAt: null },
    ...overrides,
  };
}

interface Props {
  notifications: readonly BellNotification[];
  impersonating?: boolean | null;
}

const markRead = vi.fn();

function mount(initial: Props = { notifications: [] }) {
  return renderHook(
    ({ notifications, impersonating = false }: Props) =>
      useCallToast({ notifications, impersonating, markRead }),
    { initialProps: initial }
  );
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function shownCalls(): unknown[][] {
  return vi.mocked(track).mock.calls.filter(([name]) => name === CALL_NOW_EVENTS.TOAST_SHOWN);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  globalThis.sessionStorage.clear();
  mocks.readIncoming.mockResolvedValue(null);
  mocks.readRing.mockResolvedValue({ ok: true, status: 'unanswered', expiresAtIso: '' });
  mocks.decline.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useCallToast — the ring', () => {
  it('reads the live ring on mount and shows the ringing toast, tracked as a load', async () => {
    mocks.readIncoming.mockResolvedValue(ring());
    const { result } = mount();
    await flush();

    expect(result.current.view).toMatchObject({ mode: 'ringing', ringId: 'ring-1' });
    expect(shownCalls()).toEqual([
      [CALL_NOW_EVENTS.TOAST_SHOWN, { mode: 'ringing', trigger: 'load' }],
    ]);
  });

  it('shows nothing and reads nothing while impersonating', async () => {
    mocks.readIncoming.mockResolvedValue(ring());
    const { result } = mount({ notifications: [], impersonating: true });
    await flush();

    expect(result.current.view).toBeNull();
    expect(mocks.readIncoming).not.toHaveBeenCalled();
  });

  it('reads nothing until the feed says whether the session is impersonated, then reads once', async () => {
    mocks.readIncoming.mockResolvedValue(ring());
    const { result, rerender } = mount({ notifications: [], impersonating: null });
    await flush();

    expect(mocks.readIncoming).not.toHaveBeenCalled();
    expect(result.current.view).toBeNull();

    rerender({ notifications: [], impersonating: false });
    await flush();

    expect(mocks.readIncoming).toHaveBeenCalledTimes(1);
    expect(result.current.view).toMatchObject({ mode: 'ringing' });
  });

  it('hides even a sticky missed row while impersonating', async () => {
    const { result } = mount({
      notifications: [row('m1', 'call.no_answer')],
      impersonating: true,
    });
    await flush();

    expect(result.current.view).toBeNull();
  });

  it('a new unread call.ringing row triggers a read, tracked as live', async () => {
    const { result, rerender } = mount();
    await flush();
    expect(result.current.view).toBeNull();

    mocks.readIncoming.mockResolvedValue(ring());
    rerender({ notifications: [row('r1', 'call.ringing')] });
    await flush();

    expect(mocks.readIncoming).toHaveBeenCalledTimes(2);
    expect(result.current.view).toMatchObject({ mode: 'ringing' });
    expect(shownCalls()).toEqual([
      [CALL_NOW_EVENTS.TOAST_SHOWN, { mode: 'ringing', trigger: 'live' }],
    ]);
  });

  it('does not re-read for a ringing row whose ring is already on screen', async () => {
    mocks.readIncoming.mockResolvedValue(ring());
    const { rerender } = mount();
    await flush();

    rerender({ notifications: [row('r1', 'call.ringing')] });
    await flush();

    expect(mocks.readIncoming).toHaveBeenCalledTimes(1);
  });

  it('stays ringing for the whole ring window: no timeout, no close', async () => {
    mocks.readIncoming.mockResolvedValue(ring());
    const { result } = mount();
    await flush();

    await flush(RING_MS - 1_000);

    expect(result.current.view?.mode).toBe('ringing');
    expect(mocks.readRing).not.toHaveBeenCalled();
  });
});

describe('useCallToast — the ring ends', () => {
  it('turns into the pending-missed toast when the ring lapses unanswered', async () => {
    mocks.readIncoming.mockResolvedValue(ring());
    const { result } = mount();
    await flush();

    await flush(RING_MS);

    expect(mocks.readRing).toHaveBeenCalledWith({ ringId: 'ring-1' });
    expect(result.current.view).toMatchObject({
      mode: 'missed',
      pending: true,
      callerLabel: 'Sandy',
    });
    expect(shownCalls().map(([, props]) => props)).toEqual([
      { mode: 'ringing', trigger: 'load' },
      { mode: 'missed', trigger: 'live' },
    ]);
  });

  it('treats a ring still `ringing` past its expiry as unanswered', async () => {
    mocks.readRing.mockResolvedValue({ ok: true, status: 'ringing', expiresAtIso: '' });
    mocks.readIncoming.mockResolvedValue(ring());
    const { result } = mount();
    await flush();

    await flush(RING_MS);

    expect(result.current.view).toMatchObject({ mode: 'missed', pending: true });
  });

  it('keeps a live ringing toast when its row turns read mid-ring, and settles to missed at expiry', async () => {
    mocks.readRing.mockResolvedValue({ ok: true, status: 'ringing', expiresAtIso: '' });
    mocks.readIncoming.mockResolvedValue(ring());
    const unread = row('r1', 'call.ringing');
    const { result, rerender } = mount({ notifications: [unread] });
    await flush();

    rerender({ notifications: [{ ...unread, readAt: new Date(NOW).toISOString() }] });
    await flush(1_000);

    expect(mocks.readRing).toHaveBeenCalledTimes(1);
    expect(result.current.view).toMatchObject({ mode: 'ringing', ringId: 'ring-1' });

    await flush(RING_MS);

    expect(mocks.readRing).toHaveBeenCalledTimes(2);
    expect(result.current.view).toMatchObject({ mode: 'missed', pending: true });
  });

  it.each(['declined', 'stopped', 'connected'])(
    'clears, and never shows missed, when the ring ended as %s',
    async (status) => {
      mocks.readRing.mockResolvedValue({ ok: true, status, expiresAtIso: '' });
      mocks.readIncoming.mockResolvedValue(ring());
      const { result } = mount();
      await flush();

      await flush(RING_MS);

      expect(result.current.view).toBeNull();
    }
  );

  it('clears when the ring read fails or throws', async () => {
    mocks.readRing.mockRejectedValue(new Error('boom'));
    mocks.readIncoming.mockResolvedValue(ring());
    const { result } = mount();
    await flush();

    await flush(RING_MS);

    expect(result.current.view).toBeNull();
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it('settles at once when the ring row turns read (answered or declined on another tab)', async () => {
    mocks.readRing.mockResolvedValue({ ok: true, status: 'connected', expiresAtIso: '' });
    mocks.readIncoming.mockResolvedValue(ring());
    const unread = row('r1', 'call.ringing');
    const { result, rerender } = mount({ notifications: [unread] });
    await flush();
    expect(result.current.view?.mode).toBe('ringing');

    rerender({ notifications: [{ ...unread, readAt: new Date(NOW).toISOString() }] });
    await flush();

    expect(mocks.readRing).toHaveBeenCalledTimes(1);
    expect(result.current.view).toBeNull();
  });

  it('hands the pending toast over to its row, and gives up after the grace window otherwise', async () => {
    mocks.readIncoming.mockResolvedValue(ring());
    const { result, rerender } = mount();
    await flush();
    await flush(RING_MS);
    expect(result.current.view).toMatchObject({ pending: true });

    rerender({ notifications: [row('m1', 'call.no_answer')] });
    await flush();
    expect(result.current.view).toMatchObject({ pending: false, rowIds: ['m1'] });
  });

  it('logs one missed toast for a lapsed ring, though its row replaces the pending toast', async () => {
    mocks.readIncoming.mockResolvedValue(ring());
    const { result, rerender } = mount();
    await flush();
    await flush(RING_MS);

    rerender({ notifications: [row('m1', 'call.no_answer')] });
    await flush();

    expect(result.current.view).toMatchObject({ pending: false, rowIds: ['m1'] });
    expect(shownCalls().map(([, props]) => props)).toEqual([
      { mode: 'ringing', trigger: 'load' },
      { mode: 'missed', trigger: 'live' },
    ]);
  });

  it('logs a later missed call from the same caller as its own toast', async () => {
    const first = row('m1', 'call.no_answer', {}, 'ring-a');
    const { rerender } = mount({ notifications: [first] });
    await flush();

    rerender({
      notifications: [
        row('m2', 'call.no_answer', { createdAt: new Date(NOW + 9_000).toISOString() }, 'ring-b'),
        first,
      ],
    });
    await flush();

    expect(shownCalls()).toHaveLength(2);
  });

  it('times the ring by the server clock when the device clock runs fast', async () => {
    mocks.readIncoming.mockResolvedValue(ring());
    vi.setSystemTime(NOW + 20_000);
    const { result } = mount();
    await flush();

    await flush(RING_MS - 1_000);

    expect(result.current.view).toMatchObject({ mode: 'ringing', ringId: 'ring-1' });
    expect(mocks.readRing).not.toHaveBeenCalled();

    await flush(1_000);

    expect(mocks.readRing).toHaveBeenCalledTimes(1);
    expect(result.current.view).toMatchObject({ mode: 'missed', pending: true });
  });

  it('times the ring by the server clock when the device clock runs slow', async () => {
    mocks.readIncoming.mockResolvedValue(ring());
    vi.setSystemTime(NOW - 60_000);
    const { result } = mount();
    await flush();

    await flush(RING_MS);

    expect(mocks.readRing).toHaveBeenCalledTimes(1);
    expect(result.current.view).toMatchObject({ mode: 'missed', pending: true });
  });

  it.each([
    [
      'a transient failure',
      () => mocks.readRing.mockResolvedValueOnce({ ok: false, transient: true }),
    ],
    ['a thrown read', () => mocks.readRing.mockRejectedValueOnce(new Error('blip'))],
  ])('keeps a live ring through %s mid-ring, and reads again at expiry', async (_, failOnce) => {
    mocks.readIncoming.mockResolvedValue(ring());
    const unread = row('r1', 'call.ringing');
    const { result, rerender } = mount({ notifications: [unread] });
    await flush();
    failOnce();

    rerender({ notifications: [{ ...unread, readAt: new Date(NOW).toISOString() }] });
    await flush(1_000);

    expect(mocks.readRing).toHaveBeenCalledTimes(1);
    expect(result.current.view).toMatchObject({ mode: 'ringing', ringId: 'ring-1' });

    await flush(RING_MS);

    expect(mocks.readRing).toHaveBeenCalledTimes(2);
    expect(result.current.view).toMatchObject({ mode: 'missed', pending: true });
  });

  it('clears a live ring at once on a definitive failure mid-ring', async () => {
    mocks.readRing.mockResolvedValue({ ok: false, transient: false });
    mocks.readIncoming.mockResolvedValue(ring());
    const unread = row('r1', 'call.ringing');
    const { result, rerender } = mount({ notifications: [unread] });
    await flush();

    rerender({ notifications: [{ ...unread, readAt: new Date(NOW).toISOString() }] });
    await flush();

    expect(result.current.view).toBeNull();
  });

  it('drops the pending toast after the grace window when no row arrives', async () => {
    mocks.readIncoming.mockResolvedValue(ring());
    const { result } = mount();
    await flush();
    await flush(RING_MS);
    expect(result.current.view).toMatchObject({ pending: true });

    await flush(15_000);

    expect(result.current.view).toBeNull();
  });
});

describe('useCallToast — Not now', () => {
  async function ringing() {
    mocks.readIncoming.mockResolvedValue(ring());
    const hook = mount();
    await flush();
    const view = hook.result.current.view as RingingToastView;
    return { ...hook, view };
  }

  it('asks for notification permission first, inside the click', async () => {
    const { result, view } = await ringing();

    act(() => result.current.decline(view));

    expect(mocks.requestPermission).toHaveBeenCalledTimes(1);
    const [asked] = mocks.requestPermission.mock.invocationCallOrder;
    const [declined] = mocks.decline.mock.invocationCallOrder;
    expect(asked).toBeLessThan(declined ?? 0);
  });

  it('hides the toast immediately, tracks it and tells the caller', async () => {
    const { result, view } = await ringing();

    act(() => result.current.decline(view));

    expect(result.current.view).toBeNull();
    expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.TOAST_DECLINED, { lens: 'client' });
    expect(mocks.decline).toHaveBeenCalledWith({ ringId: 'ring-1' });
    await flush();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('We’ve let Sandy know.');
  });

  it('shows an error toast when the caller could not be told, and the toast stays hidden', async () => {
    mocks.decline.mockResolvedValue({ ok: false });
    const { result, view } = await ringing();

    act(() => result.current.decline(view));
    await flush();

    expect(mocks.toastError).toHaveBeenCalledWith(
      'We couldn’t let Sandy know just now — they may keep trying.'
    );
    expect(result.current.view).toBeNull();
  });

  it('shows the error toast when the action throws', async () => {
    mocks.decline.mockRejectedValue(new Error('boom'));
    const { result, view } = await ringing();

    act(() => result.current.decline(view));
    await flush();

    expect(mocks.toastError).toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it('never becomes a missed toast when the ring then lapses', async () => {
    const { result, view } = await ringing();
    act(() => result.current.decline(view));

    await flush(RING_MS);

    expect(result.current.view).toBeNull();
    expect(shownCalls().map(([, props]) => props)).toEqual([{ mode: 'ringing', trigger: 'load' }]);
  });
});

describe('useCallToast — Join', () => {
  async function ringing(overrides: Partial<IncomingCallView>) {
    mocks.readIncoming.mockResolvedValue(ring(overrides));
    const hook = mount();
    await flush();
    return { ...hook, view: hook.result.current.view as RingingToastView };
  }

  it('a client who must answer leaves an answer intent for the call page', async () => {
    const { result, view } = await ringing({});

    act(() => result.current.join(view));

    expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.TOAST_JOIN_CLICKED, {
      lens: 'client',
      awaits_answer: true,
    });
    expect(takeAnswerIntent('meeting-1')).toBe('ring-1');
  });

  it('does not ask for notification permission: Join leaves the page before anyone could answer', async () => {
    const { result, view } = await ringing({});

    act(() => result.current.join(view));

    expect(mocks.requestPermission).not.toHaveBeenCalled();
  });

  it('an expert leaves no intent', async () => {
    const { result, view } = await ringing({ lens: 'expert', awaitsAnswer: false });

    act(() => result.current.join(view));

    expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.TOAST_JOIN_CLICKED, {
      lens: 'expert',
      awaits_answer: false,
    });
    expect(takeAnswerIntent('meeting-1')).toBeNull();
  });

  it('a client whose ring needs no answer leaves no intent', async () => {
    const { result, view } = await ringing({ awaitsAnswer: false });

    act(() => result.current.join(view));

    expect(takeAnswerIntent('meeting-1')).toBeNull();
  });
});

describe('useCallToast — the missed toast', () => {
  const missedRows = [
    row('m1', 'call.no_answer', { createdAt: new Date(NOW - 120_000).toISOString() }, 'ring-a'),
    row('m2', 'call.no_answer', { createdAt: new Date(NOW - 60_000).toISOString() }, 'ring-b'),
  ];

  it('an unread no_answer row from before this page loaded shows as a load, and never navigates', async () => {
    const { result } = mount({ notifications: missedRows });
    await flush();

    expect(result.current.view).toMatchObject({ mode: 'missed', count: 2, pending: false });
    expect(shownCalls()).toEqual([
      [CALL_NOW_EVENTS.TOAST_SHOWN, { mode: 'missed', trigger: 'load' }],
    ]);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('a row that lands while the page is open is tracked as live', async () => {
    const { rerender } = mount();
    await flush();

    rerender({
      notifications: [
        row('m9', 'call.no_answer', { createdAt: new Date(NOW + 5_000).toISOString() }),
      ],
    });
    await flush();

    expect(shownCalls()).toEqual([
      [CALL_NOW_EVENTS.TOAST_SHOWN, { mode: 'missed', trigger: 'live' }],
    ]);
  });

  it('Dismiss marks every grouped row read and tracks the count', async () => {
    const { result } = mount({ notifications: missedRows });
    await flush();
    const view = result.current.view as MissedToastView;

    act(() => result.current.dismiss(view));

    expect(markRead).toHaveBeenCalledWith(['m2', 'm1']);
    expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.MISSED_TOAST_DISMISSED, { missed_count: 2 });
    expect(mocks.requestPermission).toHaveBeenCalledTimes(1);
    const [asked] = mocks.requestPermission.mock.invocationCallOrder;
    const [tracked] = vi.mocked(track).mock.invocationCallOrder.slice(-1);
    expect(asked).toBeLessThan(tracked ?? 0);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('Call back marks the rows read, tracks, and opens the case with the confirm param', async () => {
    const { result } = mount({ notifications: missedRows });
    await flush();
    const view = result.current.view as MissedToastView;

    act(() => result.current.callBack(view));

    expect(markRead).toHaveBeenCalledWith(['m2', 'm1']);
    expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.MISSED_CALL_BACK_CLICKED, {
      missed_count: 2,
    });
    expect(mocks.push).toHaveBeenCalledWith('/cases/eng-1?call=1');
    expect(mocks.requestPermission).toHaveBeenCalledTimes(1);
    const [asked] = mocks.requestPermission.mock.invocationCallOrder;
    const [pushed] = mocks.push.mock.invocationCallOrder;
    expect(asked).toBeLessThan(pushed ?? 0);
  });

  it('clears once the feed reports those rows read (another tab dismissed it)', async () => {
    const { result, rerender } = mount({ notifications: missedRows });
    await flush();
    expect(result.current.view?.mode).toBe('missed');

    rerender({
      notifications: missedRows.map((r) => ({ ...r, readAt: new Date(NOW).toISOString() })),
    });
    await flush();

    expect(result.current.view).toBeNull();
  });

  it('marks a late row of a dismissed ring read on arrival', async () => {
    mocks.readIncoming.mockResolvedValue(ring());
    const { result, rerender } = mount();
    await flush();
    await flush(RING_MS);
    const pending = result.current.view as MissedToastView;
    expect(pending.pending).toBe(true);

    act(() => result.current.dismiss(pending));
    expect(result.current.view).toBeNull();
    markRead.mockClear();

    rerender({ notifications: [row('late', 'call.no_answer')] });
    await flush();

    expect(markRead).toHaveBeenCalledWith(['late']);
    expect(result.current.view).toBeNull();
  });

  it('marks a late row once only, so a failing read route is not hammered', async () => {
    mocks.readIncoming.mockResolvedValue(ring());
    const { result, rerender } = mount();
    await flush();
    await flush(RING_MS);
    act(() => result.current.dismiss(result.current.view as MissedToastView));
    markRead.mockClear();

    const late = [row('late', 'call.no_answer')];
    rerender({ notifications: late });
    await flush();
    rerender({ notifications: [...late] });
    await flush();

    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it('a legacy missed toast with no engagement has no way to call back, and only closes', async () => {
    const legacy = row('old', 'call.no_answer', { actionUrl: null, call: null });
    const { result } = mount({ notifications: [legacy] });
    await flush();
    const view = result.current.view as MissedToastView;

    act(() => result.current.callBack(view));

    expect(mocks.push).not.toHaveBeenCalled();
    expect(markRead).toHaveBeenCalledWith(['old']);
  });
});

describe('useCallToast — failures', () => {
  it('reports a failed ring read instead of throwing', async () => {
    mocks.readIncoming.mockRejectedValue(new Error('offline'));
    const { result } = mount();
    await flush();

    expect(result.current.view).toBeNull();
    expect(mocks.captureException).toHaveBeenCalled();
  });
});
