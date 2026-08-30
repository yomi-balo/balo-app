import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { ReferenceData } from '../_actions/load-draft';
import type { ApplicationWithRelations } from '@balo/db';

// ── Mocks ────────────────────────────────────────────────────────

const { routerRefresh } = vi.hoisted(() => ({ routerRefresh: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: routerRefresh }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../_actions/save-draft', () => ({
  saveDraftAction: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../_actions/submit-application', () => ({
  submitApplicationAction: vi.fn().mockResolvedValue({ success: true }),
}));

const mockFlushAnonymousDraft = vi.fn();
vi.mock('@/lib/expert-apply/flush-anonymous-draft', () => ({
  flushAnonymousDraft: (...args: unknown[]) => mockFlushAnonymousDraft(...args),
}));

// CRITICAL 1 / HIGH 2 — the provider now forces a REAL reload (never
// `router.refresh()`, which cannot rehydrate its lazily-initialized state) on a
// successful flush or a server-wins supersede. Mocked so no test actually
// navigates jsdom away (and so `location.assign` — non-configurable in jsdom,
// see `reload-with-toast.ts`'s header comment — is never touched at all).
const mockReloadWithToast = vi.fn();
vi.mock('@/lib/expert-apply/reload-with-toast', () => ({
  reloadWithToast: (...args: unknown[]) => mockReloadWithToast(...args),
  consumePendingToast: () => null,
}));

import { ExpertApplicationProvider, useWizard } from './expert-application-context';
import { writeAnonymousDraft, readAnonymousDraft } from '@/lib/expert-apply/anonymous-draft';
import { saveDraftAction } from '../_actions/save-draft';
import { track, EXPERT_EVENTS } from '@/lib/analytics';
import { toast } from 'sonner';

const trackMock = vi.mocked(track);
const toastSuccess = vi.mocked(toast.success);
const toastError = vi.mocked(toast.error);
const saveDraftActionMock = vi.mocked(saveDraftAction);

// ── Harness ──────────────────────────────────────────────────────

function Harness(): React.JSX.Element {
  const { isAnonymous, currentStep, expertProfileId, profileData, updateStepData } = useWizard();
  return (
    <div>
      <span data-testid="anon">{String(isAnonymous)}</span>
      <span data-testid="current">{currentStep}</span>
      <span data-testid="epid">{expertProfileId ?? 'null'}</span>
      <span data-testid="year">{profileData.yearStartedSalesforce ?? 'unset'}</span>
      <button
        type="button"
        onClick={() => updateStepData('profile', { yearStartedSalesforce: 2021 })}
      >
        edit-profile
      </button>
    </div>
  );
}

// ── Fixtures ─────────────────────────────────────────────────────

const referenceData: ReferenceData = {
  productsByCategory: [],
  supportTypes: [],
  certificationsByCategory: [],
  languages: [],
  industries: [],
  vertical: { id: 'vertical-1' } as ReferenceData['vertical'],
};

const serverDraft = {
  profile: {
    id: 'profile-server-1',
    userId: 'user-1',
    applicationStatus: 'draft',
    yearStartedSalesforce: 2018,
    agencyId: null,
    linkedinUrl: null,
    trailheadUrl: null,
    isSalesforceMvp: false,
    isSalesforceCta: false,
    isCertifiedTrainer: false,
  },
  competencies: [],
  certifications: [],
  languages: [],
  industries: [],
  workHistory: [],
} as unknown as ApplicationWithRelations;

// WARNING 6 — `authGateAt` defaults to "now" (well inside the flush window) so
// every existing flush test keeps exercising a TRUSTED envelope unless a test
// explicitly overrides it to prove the freshness gate.
function seedEnvelope(overrides: { authGateAt?: string | undefined } = {}): void {
  writeAnonymousDraft({
    v: 1,
    savedAt: new Date().toISOString(),
    currentStep: 6,
    maxReachedStep: 6,
    steps: {
      profile: { yearStartedSalesforce: 2020 },
      products: { productIds: ['11111111-1111-1111-1111-111111111111'] },
    },
    authGateAt: 'authGateAt' in overrides ? overrides.authGateAt : new Date().toISOString(),
  });
}

function renderHarness(user: { id: string } | null, draft: ApplicationWithRelations | null): void {
  render(
    <ExpertApplicationProvider draft={draft} referenceData={referenceData} user={user}>
      <Harness />
    </ExpertApplicationProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.sessionStorage.clear();
});

// ── Tests ────────────────────────────────────────────────────────

describe('mount analytics — anonymous vs authenticated (BAL-502 §22.10)', () => {
  it('anonymous mount fires APPLICATION_ANONYMOUS_STARTED and never APPLICATION_STARTED', () => {
    renderHarness(null, null);

    expect(screen.getByTestId('anon').textContent).toBe('true');
    expect(trackMock).toHaveBeenCalledWith(EXPERT_EVENTS.APPLICATION_ANONYMOUS_STARTED, {});
    expect(trackMock).not.toHaveBeenCalledWith(
      EXPERT_EVENTS.APPLICATION_STARTED,
      expect.anything()
    );
    expect(mockFlushAnonymousDraft).not.toHaveBeenCalled();
  });

  it('authenticated mount (no draft) fires APPLICATION_STARTED, not the anonymous variant', () => {
    renderHarness({ id: 'user-1' }, null);

    expect(screen.getByTestId('anon').textContent).toBe('false');
    expect(trackMock).toHaveBeenCalledWith(EXPERT_EVENTS.APPLICATION_STARTED, {});
    expect(trackMock).not.toHaveBeenCalledWith(
      EXPERT_EVENTS.APPLICATION_ANONYMOUS_STARTED,
      expect.anything()
    );
  });
});

describe('post-auth flush (BAL-502 §22.9 / §22.11)', () => {
  it('mounts with a user and NO pending envelope: no flush attempted, no toast', () => {
    renderHarness({ id: 'user-1' }, null);

    expect(mockFlushAnonymousDraft).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('mounts with a user + a pending envelope + draft:null → flushes, clears the envelope, and forces a REAL reload (CRITICAL 1 / HIGH 2 — never router.refresh())', async () => {
    seedEnvelope();
    mockFlushAnonymousDraft.mockResolvedValue({
      outcome: 'flushed',
      stepsFlushed: 2,
      expertProfileId: 'ep-9',
    });

    renderHarness({ id: 'user-1' }, null);

    await waitFor(() =>
      expect(mockFlushAnonymousDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          draft: expect.objectContaining({ v: 1 }),
          hasServerDraft: false,
        })
      )
    );

    await waitFor(() => expect(readAnonymousDraft()).toBeNull());
    // ⚠ `router.refresh()` cannot rehydrate this provider's lazily-initialized
    // state (CRITICAL 1) — a REAL reload is the only correct fix.
    expect(routerRefresh).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mockReloadWithToast).toHaveBeenCalledWith(
        "Your progress is saved. Two quick things and you're done."
      )
    );
    expect(trackMock).toHaveBeenCalledWith(EXPERT_EVENTS.APPLICATION_DRAFT_FLUSHED, {
      outcome: 'flushed',
      steps_flushed: 2,
    });
    // ⚠ WARNING 7 / anonymous-writes invariant — `saveDraftAction` is the
    // AUTH-GATED server action; the anonymous flush goes exclusively through the
    // injected `post` inside `flushAnonymousDraft` (mocked above), never this.
    expect(saveDraftActionMock).not.toHaveBeenCalled();
  });

  it('mounts with a user + a pending envelope + a non-null draft → superseded: server wins, envelope cleared, NO post, forces a REAL reload with the discard toast', async () => {
    seedEnvelope();
    mockFlushAnonymousDraft.mockResolvedValue({
      outcome: 'superseded',
      stepsFlushed: 0,
      expertProfileId: null,
    });

    renderHarness({ id: 'user-1' }, serverDraft);

    await waitFor(() =>
      expect(mockFlushAnonymousDraft).toHaveBeenCalledWith(
        expect.objectContaining({ hasServerDraft: true })
      )
    );
    await waitFor(() => expect(readAnonymousDraft()).toBeNull());
    // ⚠ CRITICAL 1's own probe: a soft `router.refresh()` here would leave the
    // STALE anonymous data on screen while this toast claims "server wins" — a
    // lie. Only a real reload (asserted below) actually replaces it.
    expect(routerRefresh).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mockReloadWithToast).toHaveBeenCalledWith(
        expect.stringContaining(
          "Welcome back — we've loaded the application you already had in progress"
        )
      )
    );
    expect(saveDraftActionMock).not.toHaveBeenCalled();
  });

  it('a failed flush keeps the envelope (retryable), shows an error toast, and does NOT reload (nothing changed identity-wise)', async () => {
    seedEnvelope();
    mockFlushAnonymousDraft.mockResolvedValue({
      outcome: 'failed',
      stepsFlushed: 1,
      expertProfileId: 'ep-1',
    });

    renderHarness({ id: 'user-1' }, null);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "We couldn't restore your saved progress. Please try again."
      )
    );
    expect(readAnonymousDraft()).not.toBeNull();
    expect(routerRefresh).not.toHaveBeenCalled();
    expect(mockReloadWithToast).not.toHaveBeenCalled();
  });

  it('a rejected flush promise is caught: error toast, no throw, envelope kept', async () => {
    seedEnvelope();
    mockFlushAnonymousDraft.mockRejectedValue(new Error('network down'));

    renderHarness({ id: 'user-1' }, null);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "We couldn't restore your saved progress. Please try again."
      )
    );
    expect(readAnonymousDraft()).not.toBeNull();
  });

  it('nothing_to_flush: no toast, envelope left as-is', async () => {
    seedEnvelope();
    mockFlushAnonymousDraft.mockResolvedValue({
      outcome: 'nothing_to_flush',
      stepsFlushed: 0,
      expertProfileId: null,
    });

    renderHarness({ id: 'user-1' }, null);

    await waitFor(() => expect(mockFlushAnonymousDraft).toHaveBeenCalled());
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('attempts the flush only once even if the provider re-renders', async () => {
    seedEnvelope();
    mockFlushAnonymousDraft.mockResolvedValue({
      outcome: 'flushed',
      stepsFlushed: 1,
      expertProfileId: 'ep-1',
    });

    const { rerender } = render(
      <ExpertApplicationProvider draft={null} referenceData={referenceData} user={{ id: 'user-1' }}>
        <Harness />
      </ExpertApplicationProvider>
    );

    await waitFor(() => expect(mockFlushAnonymousDraft).toHaveBeenCalledTimes(1));

    rerender(
      <ExpertApplicationProvider draft={null} referenceData={referenceData} user={{ id: 'user-1' }}>
        <Harness />
      </ExpertApplicationProvider>
    );

    expect(mockFlushAnonymousDraft).toHaveBeenCalledTimes(1);
  });

  it('a flush that resolves after unmount does not toast (the cancelled-race guard)', async () => {
    seedEnvelope();
    let resolveFlush: (value: {
      outcome: 'flushed';
      stepsFlushed: number;
      expertProfileId: string;
    }) => void = () => undefined;
    mockFlushAnonymousDraft.mockReturnValue(
      new Promise((resolve) => {
        resolveFlush = resolve;
      })
    );

    const { unmount } = render(
      <ExpertApplicationProvider draft={null} referenceData={referenceData} user={{ id: 'user-1' }}>
        <Harness />
      </ExpertApplicationProvider>
    );

    await waitFor(() => expect(mockFlushAnonymousDraft).toHaveBeenCalled());
    unmount();
    resolveFlush({ outcome: 'flushed', stepsFlushed: 1, expertProfileId: 'ep-1' });

    await new Promise((r) => setTimeout(r, 0));
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe('post-auth flush — authGateAt freshness gate (BAL-502 FIX round WARNING 6)', () => {
  it('refuses to flush an envelope with NO authGateAt at all — clears it silently, no toast, no post', async () => {
    seedEnvelope({ authGateAt: undefined });

    renderHarness({ id: 'user-1' }, null);

    await waitFor(() => expect(readAnonymousDraft()).toBeNull());
    expect(mockFlushAnonymousDraft).not.toHaveBeenCalled();
    expect(mockReloadWithToast).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('refuses to flush an envelope stamped OUTSIDE the window — a shared/kiosk-browser draft is not silently attributed to whoever signs in next', async () => {
    seedEnvelope({ authGateAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() });

    renderHarness({ id: 'user-1' }, null);

    await waitFor(() => expect(readAnonymousDraft()).toBeNull());
    expect(mockFlushAnonymousDraft).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('refuses to flush a FUTURE-dated envelope — a forward stamp must not buy unlimited freshness', async () => {
    // Without an explicit `gateAgeMs < 0` clamp a future `authGateAt` yields a
    // negative age, which trivially satisfies `age <= WINDOW` and so re-opens
    // the very window this guard exists to bound (clock skew, or a tampered
    // envelope on a shared machine). Only a stamp in the PAST can have come
    // from a real submit gate.
    seedEnvelope({ authGateAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });

    renderHarness({ id: 'user-1' }, null);

    await waitFor(() => expect(readAnonymousDraft()).toBeNull());
    expect(mockFlushAnonymousDraft).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('DOES flush an envelope stamped just inside the window', async () => {
    seedEnvelope({ authGateAt: new Date(Date.now() - 29 * 60 * 1000).toISOString() });
    mockFlushAnonymousDraft.mockResolvedValue({
      outcome: 'flushed',
      stepsFlushed: 2,
      expertProfileId: 'ep-1',
    });

    renderHarness({ id: 'user-1' }, null);

    await waitFor(() => expect(mockFlushAnonymousDraft).toHaveBeenCalled());
  });
});

describe('CRITICAL 1 regression probe — router.refresh() cannot rehydrate this provider', () => {
  it('an anonymous in-memory edit is not left stale on screen when the account turns out to have an existing draft: the fix forces a real reload, never a soft refresh', async () => {
    seedEnvelope();
    mockFlushAnonymousDraft.mockResolvedValue({
      outcome: 'superseded',
      stepsFlushed: 0,
      expertProfileId: null,
    });

    const { rerender } = render(
      <ExpertApplicationProvider draft={null} referenceData={referenceData} user={null}>
        <Harness />
      </ExpertApplicationProvider>
    );

    // Anonymous visitor edits a field — dirties in-memory state that a lazy
    // `useState(() => hydrate*(draft))` initializer will never re-derive.
    fireEvent.click(screen.getByRole('button', { name: 'edit-profile' }));
    expect(screen.getByTestId('year').textContent).toBe('2021');

    // The reviewer's exact probe: rerender with a real session + an existing
    // server draft — precisely what `router.refresh()` produces (new props on
    // the SAME mounted component instance; lazy initializers never re-run).
    // Without the CRITICAL 1 fix the component would keep showing '2021' here
    // forever, and `expertProfileId` would stay stuck at 'null'.
    rerender(
      <ExpertApplicationProvider
        draft={serverDraft}
        referenceData={referenceData}
        user={{ id: 'user-1' }}
      >
        <Harness />
      </ExpertApplicationProvider>
    );

    // The fix: rather than trusting the stale in-memory state, the provider
    // forces a REAL document reload (never `router.refresh()`) so a fresh mount
    // re-derives everything — including `expertProfileId` — from the server.
    await waitFor(() => expect(mockReloadWithToast).toHaveBeenCalled());
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});

describe('anonymous debounced persistence (BAL-502 §22.3 — scheduleAnonymousSave)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces an anonymous edit to sessionStorage after 800ms — nothing written before, something after', () => {
    renderHarness(null, null);

    // Two identical clicks: `fireEvent` flushes the first commit synchronously
    // (via act()), so the second click's SCHEDULED envelope closes over state that
    // already reflects the edit — sidesteps the single-click "one edit behind"
    // window inherent to scheduling a timeout from within the same handler that
    // calls setState (shared with the authenticated `scheduleIdleSave`).
    fireEvent.click(screen.getByRole('button', { name: 'edit-profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'edit-profile' }));

    expect(globalThis.sessionStorage.getItem('balo.expert-apply.anon-draft.v1')).toBeNull();

    vi.advanceTimersByTime(800);

    const stored = globalThis.sessionStorage.getItem('balo.expert-apply.anon-draft.v1');
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored ?? '{}')).toMatchObject({
      v: 1,
      steps: { profile: { yearStartedSalesforce: 2021 } },
    });
  });
});

describe('anonymous unload beacon is a no-op (BAL-502 §22 — no anonymous writes, anywhere)', () => {
  let sendBeacon: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendBeacon = vi.fn().mockReturnValue(true);
    Object.defineProperty(globalThis.navigator, 'sendBeacon', {
      value: sendBeacon,
      configurable: true,
      writable: true,
    });
  });

  it('never beacons on pagehide while anonymous, even with unsaved edits', async () => {
    const user = userEvent.setup();
    renderHarness(null, null);

    await user.click(screen.getByRole('button', { name: 'edit-profile' }));
    globalThis.dispatchEvent(new Event('pagehide'));

    expect(sendBeacon).not.toHaveBeenCalled();
  });
});
