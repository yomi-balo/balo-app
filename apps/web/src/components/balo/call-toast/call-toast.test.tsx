import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { takeAnswerIntent } from '@/lib/call-now/answer-intent';
import { CallToast } from './call-toast';
import type { MissedToastView, RingingToastView } from './call-toast-model';
import { useCallToast } from './use-call-toast';

const mocks = vi.hoisted(() => ({
  reduced: false,
  ringSound: vi.fn(),
  browserNotification: vi.fn(),
  readIncoming: vi.fn(),
}));

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return { ...createMotionStub(), useReducedMotion: () => mocks.reduced };
});
vi.mock('./use-call-ring-sound', () => ({ useCallRingSound: mocks.ringSound }));
vi.mock('./use-call-browser-notification', () => ({
  useCallBrowserNotification: mocks.browserNotification,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/call-now/actions/read-incoming-call', () => ({
  readIncomingCallAction: mocks.readIncoming,
}));
vi.mock('@/lib/call-now/actions/decline-call-now-ring', () => ({
  declineCallNowRingAction: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('@/app/(call)/meetings/[meetingId]/call/_actions/read-call-now-ring', () => ({
  readCallNowRingAction: vi.fn(),
}));

function ringing(overrides: Partial<RingingToastView> = {}): RingingToastView {
  return {
    mode: 'ringing',
    ringId: 'ring-1',
    meetingId: 'meeting-1',
    engagementId: 'eng-1',
    lens: 'client',
    callerLabel: 'Sandy',
    caseTitle: 'Flow migration',
    rateLine: 'From A$2.00/min · 15-minute minimum',
    awaitsAnswer: true,
    joinPath: '/meetings/meeting-1/call',
    expiresAtIso: '2026-11-19T10:00:30.000Z',
    ...overrides,
  };
}

function missed(overrides: Partial<MissedToastView> = {}): MissedToastView {
  return {
    mode: 'missed',
    key: 'rows:m1',
    rowIds: ['m1'],
    count: 1,
    callerLabel: 'Sandy',
    startedAt: '2026-11-19T04:05:00.000Z',
    engagementId: 'eng-1',
    fallbackTitle: null,
    fallbackBody: null,
    ringId: 'ring-1',
    pending: false,
    ...overrides,
  };
}

function setup(
  view: RingingToastView | MissedToastView | null,
  returnFocusRef?: React.RefObject<HTMLElement | null>
) {
  const handlers = {
    onJoin: vi.fn(),
    onDecline: vi.fn(),
    onDismiss: vi.fn(),
    onCallBack: vi.fn(),
  };
  render(<CallToast view={view} returnFocusRef={returnFocusRef} {...handlers} />);
  return handlers;
}

const realLocation = globalThis.location;
let mockAssign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reduced = false;
  mockAssign = vi.fn();
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: realLocation.href, origin: realLocation.origin, assign: mockAssign },
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'location', { configurable: true, value: realLocation });
  vi.useRealTimers();
});

describe('CallToast — ringing', () => {
  it('names the caller and the case, and offers Join and Not now', () => {
    setup(ringing());

    const dialog = screen.getByRole('alertdialog', { name: 'Sandy is calling' });
    expect(dialog).toHaveTextContent('About Flow migration.');
    expect(screen.getByRole('button', { name: 'Join Sandy’s call' })).toHaveTextContent('Join');
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
  });

  it('has no Dismiss button in ringing mode', () => {
    setup(ringing());

    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  it('is still there after ten minutes of fake time: no timeout of its own', async () => {
    vi.useFakeTimers();
    setup(ringing());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('shows the rate line and the 15-minute minimum to a client', () => {
    setup(ringing());

    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'From A$2.00/min · 15-minute minimum. The timer starts when you’re both in.'
    );
  });

  it('shows a client with no rate the timer line alone', () => {
    setup(ringing({ rateLine: null }));

    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'About Flow migration. The timer starts when you’re both in.'
    );
  });

  it('shows an expert no money and no terms', () => {
    setup(
      ringing({ lens: 'expert', rateLine: null, awaitsAnswer: false, callerLabel: 'Northwind' })
    );

    const dialog = screen.getByRole('alertdialog', { name: 'Northwind is calling' });
    expect(dialog).toHaveTextContent('About Flow migration.');
    expect(dialog).not.toHaveTextContent('A$');
    expect(dialog).not.toHaveTextContent('timer');
  });

  it('has no in-place choice in any mode', () => {
    const { container } = render(
      <CallToast
        view={ringing()}
        onJoin={vi.fn()}
        onDecline={vi.fn()}
        onDismiss={vi.fn()}
        onCallBack={vi.fn()}
      />
    );

    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('Join runs onJoin then hard-navigates to the call route', async () => {
    const handlers = setup(ringing());

    await userEvent.click(screen.getByRole('button', { name: 'Join Sandy’s call' }));

    expect(handlers.onJoin).toHaveBeenCalledTimes(1);
    expect(handlers.onJoin).toHaveBeenCalledWith(expect.objectContaining({ ringId: 'ring-1' }));
    expect(mockAssign).toHaveBeenCalledWith('/meetings/meeting-1/call');
  });

  it('Not now calls onDecline and does not navigate', async () => {
    const handlers = setup(ringing());

    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));

    expect(handlers.onDecline).toHaveBeenCalledWith(expect.objectContaining({ ringId: 'ring-1' }));
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it('announces the call once: the alertdialog names itself, the announcer stays silent, and it rings only while ringing', () => {
    setup(ringing());

    const announcer = document.querySelector('[data-slot="call-toast-announcer"]');
    expect(announcer).toBeEmptyDOMElement();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAccessibleName('Sandy is calling');
    expect(dialog).toHaveAccessibleDescription(/About Flow migration\./);
    expect(
      [...document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')].filter(
        (el) => (el.textContent ?? '') !== ''
      )
    ).toHaveLength(0);
    expect(mocks.ringSound).toHaveBeenLastCalledWith(true);
    expect(mocks.browserNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({ ringId: 'ring-1' })
    );
  });
});

describe('CallToast — missed', () => {
  it('reads as a polite status with the time and a Call back action', () => {
    setup(missed());

    const status = screen.getByRole('status', { name: 'You missed a call from Sandy' });
    expect(status).toHaveTextContent(/They tried to reach you at \d{1,2}:\d{2}/);
    expect(screen.getByRole('button', { name: 'Call back' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join Sandy’s call' })).not.toBeInTheDocument();
    expect(mocks.ringSound).toHaveBeenLastCalledWith(false);
    expect(mocks.browserNotification).toHaveBeenLastCalledWith(null);
  });

  it('counts several missed calls from the same person', () => {
    setup(missed({ count: 3 }));

    expect(screen.getByRole('status', { name: '3 missed calls from Sandy' })).toBeInTheDocument();
  });

  it('falls back to the legacy row title and body when the row has no label', () => {
    setup(
      missed({
        callerLabel: null,
        fallbackTitle: 'Missed call from Sandy',
        fallbackBody: 'Old body',
        startedAt: null,
      })
    );

    const status = screen.getByRole('status', { name: 'Missed call from Sandy' });
    expect(status).toHaveTextContent('Old body');
  });

  it('has a Dismiss X and Call back that call their handlers', async () => {
    const handlers = setup(missed());

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await userEvent.click(screen.getByRole('button', { name: 'Call back' }));

    expect(handlers.onDismiss).toHaveBeenCalledWith(expect.objectContaining({ key: 'rows:m1' }));
    expect(handlers.onCallBack).toHaveBeenCalledWith(expect.objectContaining({ key: 'rows:m1' }));
  });

  it('offers no Call back when the row names no case', () => {
    setup(missed({ engagementId: null }));

    expect(screen.queryByRole('button', { name: 'Call back' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('does not ask for the time when it is unreadable', () => {
    setup(missed({ startedAt: 'nope' }));

    expect(screen.getByRole('status', { name: 'You missed a call from Sandy' })).toHaveTextContent(
      'They tried to reach you.'
    );
  });
});

describe('CallToast — empty and motion', () => {
  it('renders no card without a view', () => {
    setup(null);

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="call-toast"]')).toBeNull();
  });

  it('animates in by default and does not under reduced motion', () => {
    const { unmount } = render(
      <CallToast
        view={ringing()}
        onJoin={vi.fn()}
        onDecline={vi.fn()}
        onDismiss={vi.fn()}
        onCallBack={vi.fn()}
      />
    );
    expect(document.querySelector('[data-slot="call-toast"]')).toHaveAttribute(
      'data-animated',
      'true'
    );
    unmount();

    mocks.reduced = true;
    render(
      <CallToast
        view={ringing()}
        onJoin={vi.fn()}
        onDecline={vi.fn()}
        onDismiss={vi.fn()}
        onCallBack={vi.fn()}
      />
    );
    expect(document.querySelector('[data-slot="call-toast"]')).toHaveAttribute(
      'data-animated',
      'false'
    );
  });
});

describe('CallToast wired to useCallToast', () => {
  function Harness(): React.JSX.Element {
    const toast = useCallToast({ notifications: [], impersonating: false, markRead: vi.fn() });
    return (
      <CallToast
        view={toast.view}
        onJoin={toast.join}
        onDecline={toast.decline}
        onDismiss={toast.dismiss}
        onCallBack={toast.callBack}
      />
    );
  }

  const live = {
    ringId: 'ring-1',
    meetingId: 'meeting-1',
    engagementId: 'eng-1',
    callerLabel: 'Sandy',
    caseTitle: null,
    rateLine: null,
    expiresAtIso: new Date(Date.now() + 60_000).toISOString(),
    startedAtIso: new Date().toISOString(),
    joinPath: '/meetings/meeting-1/call',
  };

  it('a client with awaitsAnswer has written the intent before the page navigates', async () => {
    globalThis.sessionStorage.clear();
    mocks.readIncoming.mockResolvedValue({ ...live, lens: 'client', awaitsAnswer: true });
    let intentAtNavigation: string | null = null;
    mockAssign.mockImplementation(() => {
      intentAtNavigation = takeAnswerIntent('meeting-1');
    });
    render(<Harness />);

    await userEvent.click(await screen.findByRole('button', { name: 'Join Sandy’s call' }));

    expect(intentAtNavigation).toBe('ring-1');
  });

  it('an expert writes none', async () => {
    globalThis.sessionStorage.clear();
    mocks.readIncoming.mockResolvedValue({ ...live, lens: 'expert', awaitsAnswer: false });
    let intentAtNavigation: string | null = 'unset';
    mockAssign.mockImplementation(() => {
      intentAtNavigation = takeAnswerIntent('meeting-1');
    });
    render(<Harness />);

    await userEvent.click(await screen.findByRole('button', { name: 'Join Sandy’s call' }));

    expect(intentAtNavigation).toBeNull();
    expect(mockAssign).toHaveBeenCalledWith('/meetings/meeting-1/call');
  });
});

describe('CallToast — focus', () => {
  function withTrigger(view: RingingToastView | MissedToastView) {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    const ref = { current: trigger };
    const handlers = setup(view, ref);
    return { trigger, handlers };
  }

  it('moves focus to the bell trigger when Not now closes the toast', async () => {
    const { trigger } = withTrigger(ringing());

    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));

    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it('moves focus to the bell trigger when Dismiss closes a missed toast', async () => {
    const { trigger } = withTrigger(missed());

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it('never takes focus when the toast appears', () => {
    const { trigger } = withTrigger(ringing());

    expect(trigger).not.toHaveFocus();
    expect(document.body.contains(document.activeElement)).toBe(true);
    expect(screen.getByRole('alertdialog').contains(document.activeElement)).toBe(false);
    trigger.remove();
  });
});
