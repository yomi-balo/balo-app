import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
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
import {
  writeAnonymousDraft,
  readAnonymousDraft,
  stampAuthGate,
} from '@/lib/expert-apply/anonymous-draft';
import { saveDraftAction } from '../_actions/save-draft';
import { track, EXPERT_EVENTS } from '@/lib/analytics';
import { toast } from 'sonner';

const trackMock = vi.mocked(track);
const toastSuccess = vi.mocked(toast.success);
const toastError = vi.mocked(toast.error);
const saveDraftActionMock = vi.mocked(saveDraftAction);

// ── Harness ──────────────────────────────────────────────────────

function Harness(): React.JSX.Element {
  const {
    isAnonymous,
    currentStep,
    maxReachedStep,
    stepStatuses,
    expertProfileId,
    profileData,
    productsData,
    termsData,
    updateStepData,
    saveAnonymousDraftNow,
    goNext,
    goToStep,
  } = useWizard();
  return (
    <div>
      <span data-testid="anon">{String(isAnonymous)}</span>
      <span data-testid="current">{currentStep}</span>
      <span data-testid="max-reached">{maxReachedStep}</span>
      <span data-testid="statuses">{stepStatuses.join(',')}</span>
      <span data-testid="epid">{expertProfileId ?? 'null'}</span>
      <span data-testid="year">{profileData.yearStartedSalesforce ?? 'unset'}</span>
      <span data-testid="products">{(productsData.productIds ?? []).join(',') || 'none'}</span>
      {/* `undefined` here (rather than 0) means a restore REPLACED state instead of
          merging, dropping the `languages: []` guarantee `hydrateProfileData(null)` makes
          and handing the step a non-array to map over. */}
      <span data-testid="languages">{String(profileData.languages?.length ?? 'undefined')}</span>
      {/* Spreading a string or array into a slice mints numeric index keys ({0:'n',
          1:'o', …}) which then serialize back into the envelope and POST to
          `saveDraftAction`. The merge alone does NOT prevent that — only the
          plain-object guard does. */}
      <span data-testid="profile-keys">{Object.keys(profileData).sort().join(',')}</span>
      <span data-testid="terms">{String(termsData.termsAccepted ?? false)}</span>
      <button
        type="button"
        onClick={() => updateStepData('profile', { yearStartedSalesforce: 2021 })}
      >
        edit-profile
      </button>
      <button type="button" onClick={() => saveAnonymousDraftNow()}>
        cross-auth-gate
      </button>
      <button type="button" onClick={() => void goNext()}>
        next
      </button>
      <button type="button" onClick={() => goToStep(0)}>
        rail-click-first
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

// ── BAL-562 ──────────────────────────────────────────────────────

/**
 * The anonymous→signed-in transition the BAL-562 probes share: render with no session,
 * then hand back a `signIn()` that re-renders the SAME mount with one — which is what
 * `router.refresh()` does after the email auth modal succeeds.
 */
function renderAnonymousThenSignIn(): { signIn: () => void } {
  const { rerender } = render(
    <ExpertApplicationProvider draft={null} referenceData={referenceData} user={null}>
      <Harness />
    </ExpertApplicationProvider>
  );
  return {
    signIn: () =>
      rerender(
        <ExpertApplicationProvider
          draft={null}
          referenceData={referenceData}
          user={{ id: 'user-1' }}
        >
          <Harness />
        </ExpertApplicationProvider>
      ),
  };
}

describe('BAL-562 — the auth-gate stamp survives the debounce that lands after it', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * THE REGRESSION PROBE. Revert either half of the fix — the sticky carry-forward in
   * `writeAnonymousDraft`, or the `clearTimeout` in `saveAnonymousDraftNow` — and the
   * envelope reaching the flush has no `authGateAt`, the freshness gate clears it, and
   * `flushAnonymousDraft` is never called: seven steps of work discarded in silence.
   *
   * The trigger is the ORDINARY interaction, not an edge case — the last thing a
   * visitor does before crossing the gate is touch a field on the Terms step, which
   * arms the very 800ms timer that used to strip the stamp.
   */
  it('an edit within 800ms of crossing the gate does not cost the visitor their application', () => {
    mockFlushAnonymousDraft.mockResolvedValue({ outcome: 'flushed', stepsFlushed: 1 });

    const { signIn } = renderAnonymousThenSignIn();

    // The visitor edits a field — arming the anonymous debounce...
    fireEvent.click(screen.getByRole('button', { name: 'edit-profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'edit-profile' }));
    // ...and crosses the submit gate before it fires.
    fireEvent.click(screen.getByRole('button', { name: 'cross-auth-gate' }));

    const stamped = JSON.parse(
      globalThis.sessionStorage.getItem('balo.expert-apply.anon-draft.v1') ?? '{}'
    ) as Record<string, unknown>;
    expect(stamped.authGateAt).toEqual(expect.any(String));

    // The debounce's window elapses while the auth modal is open.
    vi.advanceTimersByTime(800);

    const afterDebounce = JSON.parse(
      globalThis.sessionStorage.getItem('balo.expert-apply.anon-draft.v1') ?? '{}'
    ) as Record<string, unknown>;
    expect(afterDebounce.authGateAt).toBe(stamped.authGateAt);

    // Sign-in completes and `router.refresh()` re-renders this same mount WITH a session.
    signIn();

    expect(mockFlushAnonymousDraft).toHaveBeenCalledTimes(1);
  });

  /**
   * Isolates the STICKY half of the fix. The header's "Log in" (`ApplyHeaderActions`)
   * stamps through storage and never touches `saveAnonymousDraftNow`, so the
   * `clearTimeout` there cannot save this path — only the carry-forward in
   * `writeAnonymousDraft` can. Revert that carry-forward and this fails while the
   * probe above still passes.
   */
  it('a stamp made from outside the provider survives the debounce that lands after it', () => {
    mockFlushAnonymousDraft.mockResolvedValue({ outcome: 'flushed', stepsFlushed: 1 });

    const { signIn } = renderAnonymousThenSignIn();

    // Establish an envelope, then stamp it the way the apply header does.
    fireEvent.click(screen.getByRole('button', { name: 'edit-profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'edit-profile' }));
    vi.advanceTimersByTime(800);
    expect(stampAuthGate()).toBe(true);

    // The visitor edits once more before the redirect — arming a fresh debounce that
    // rebuilds the envelope from live state, with no knowledge of the stamp.
    fireEvent.click(screen.getByRole('button', { name: 'edit-profile' }));
    vi.advanceTimersByTime(800);

    expect(readAnonymousDraft()?.authGateAt).toEqual(expect.any(String));

    signIn();

    expect(mockFlushAnonymousDraft).toHaveBeenCalledTimes(1);
  });

  it('cancels the pending debounce outright, so the gate write is the last to touch storage', () => {
    renderAnonymousThenSignIn();

    fireEvent.click(screen.getByRole('button', { name: 'edit-profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'edit-profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'cross-auth-gate' }));

    const atGate = globalThis.sessionStorage.getItem('balo.expert-apply.anon-draft.v1');
    vi.advanceTimersByTime(800);

    expect(globalThis.sessionStorage.getItem('balo.expert-apply.anon-draft.v1')).toBe(atGate);
  });
});

describe('BAL-562 — anonymous resume from sessionStorage', () => {
  function seedResumableEnvelope(): void {
    writeAnonymousDraft({
      v: 1,
      savedAt: new Date().toISOString(),
      currentStep: 4,
      maxReachedStep: 5,
      stepStatuses: [
        'completed',
        'completed',
        'completed',
        'skipped',
        'pending',
        'pending',
        'pending',
      ],
      steps: {
        profile: { yearStartedSalesforce: 2016 },
        products: { productIds: ['11111111-1111-1111-1111-111111111111'] },
        terms: { termsAccepted: true },
      },
    });
  }

  it('restores field data across a reload instead of showing an empty wizard', () => {
    seedResumableEnvelope();
    renderHarness(null, null);

    expect(screen.getByTestId('year').textContent).toBe('2016');
    expect(screen.getByTestId('products').textContent).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('restores position and the furthest step reached — the URL cannot, since ?step= is clamped to 0 while draft is null', () => {
    seedResumableEnvelope();
    renderHarness(null, null);

    expect(screen.getByTestId('current').textContent).toBe('4');
    expect(screen.getByTestId('max-reached').textContent).toBe('5');
  });

  it('restores the progress rail, which is navigation-derived and implied by nothing else in the envelope', () => {
    seedResumableEnvelope();
    renderHarness(null, null);

    expect(screen.getByTestId('statuses').textContent).toBe(
      'completed,completed,completed,skipped,pending,pending,pending'
    );
  });

  it('never restores terms acceptance — consent is re-affirmed on every visit', () => {
    seedResumableEnvelope();
    renderHarness(null, null);

    expect(screen.getByTestId('terms').textContent).toBe('false');
  });

  it('does not overwrite the restored envelope on the next keystroke', async () => {
    seedResumableEnvelope();
    renderHarness(null, null);

    // Two clicks, per the `scheduleAnonymousSave` note above: the first schedules an
    // envelope closing over PRE-edit state, the second closes over the committed edit.
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'edit-profile' }));
    await user.click(screen.getByRole('button', { name: 'edit-profile' }));

    // Wait for the debounce to actually LAND first. Asserting survival before the
    // write happens would pass against the seeded envelope and prove nothing —
    // this is the difference between pinning the fix and pinning the fixture.
    await waitFor(
      () => {
        expect(readAnonymousDraft()?.steps.profile).toEqual({ yearStartedSalesforce: 2021 });
      },
      { timeout: 3000 }
    );

    // Only now is the assertion meaningful: the rewritten envelope was built from
    // RESTORED state, so a step the visitor never returned to is still in it.
    expect(readAnonymousDraft()?.steps.products).toEqual({
      productIds: ['11111111-1111-1111-1111-111111111111'],
    });
  });

  it('clamps a position that exceeds the current STEP_CONFIG length (an envelope from an older build)', () => {
    writeAnonymousDraft({
      v: 1,
      savedAt: new Date().toISOString(),
      currentStep: 99,
      maxReachedStep: 99,
      steps: { profile: { yearStartedSalesforce: 2016 } },
    });
    renderHarness(null, null);

    expect(Number(screen.getByTestId('current').textContent)).toBeLessThanOrEqual(6);
    expect(Number(screen.getByTestId('max-reached').textContent)).toBeLessThanOrEqual(6);
  });

  it('leaves the wizard pristine when there is no envelope at all', () => {
    renderHarness(null, null);

    expect(screen.getByTestId('year').textContent).toBe('unset');
    expect(screen.getByTestId('current').textContent).toBe('0');
  });

  it('never rehydrates for a SIGNED-IN visitor — the server draft is the only source there', () => {
    seedResumableEnvelope();
    mockFlushAnonymousDraft.mockResolvedValue({ outcome: 'nothing_to_flush', stepsFlushed: 0 });

    renderHarness({ id: 'user-1' }, serverDraft);

    // 2018 is the SERVER draft's value; 2016 is the anonymous envelope's.
    expect(screen.getByTestId('year').textContent).toBe('2018');
  });
});

describe('BAL-562 — what actually lands in storage when the wizard is DRIVEN', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function clickAndFlush(name: string): Promise<void> {
    return act(async () => {
      fireEvent.click(screen.getByRole('button', { name }));
    });
  }

  /**
   * THE REGRESSION PROBE for the stale-transition defect. Every other restore test
   * hand-seeds the envelope via `writeAnonymousDraft`, so none of them can see what the
   * wizard itself writes — by this PR's own standard they pin the fixture.
   *
   * `goNext` calls `performSave()` (which writes) and only THEN marks the step complete
   * and advances, and nothing wrote on arrival. Revert the transition effect and storage
   * holds `currentStep: 0` with the profile step still `pending` — a visitor who clicks
   * through and reloads lands a step back, on a rail that denies what they just did.
   */
  it('records the step ARRIVED at, not the step departed from', async () => {
    renderAnonymousThenSignIn();

    fireEvent.click(screen.getByRole('button', { name: 'edit-profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'edit-profile' }));
    vi.advanceTimersByTime(800);
    expect(readAnonymousDraft()?.currentStep).toBe(0);

    await clickAndFlush('next');

    expect(screen.getByTestId('current').textContent).toBe('1');
    expect(readAnonymousDraft()?.currentStep).toBe(1);
  });

  it('records the completed step on the rail, so a resumed visitor is not told they skipped it', async () => {
    renderAnonymousThenSignIn();

    fireEvent.click(screen.getByRole('button', { name: 'edit-profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'edit-profile' }));
    vi.advanceTimersByTime(800);

    await clickAndFlush('next');

    expect(readAnonymousDraft()?.stepStatuses?.[0]).toBe('completed');
  });

  it('raises maxReachedStep in storage, so the restored wizard keeps the step navigable', async () => {
    renderAnonymousThenSignIn();

    fireEvent.click(screen.getByRole('button', { name: 'edit-profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'edit-profile' }));
    vi.advanceTimersByTime(800);

    await clickAndFlush('next');

    expect(readAnonymousDraft()?.maxReachedStep).toBe(1);
  });

  /**
   * The same defect shape as the auth-gate stamp, one call site over: the `[currentStep]`
   * cleanup used to clear only `idleTimerRef`, so a debounce armed just before Continue
   * fired ~800ms later with a closure over pre-edit, pre-advance state and overwrote the
   * good write. Revert that cancel and `currentStep` collapses back to 0.
   */
  it('a debounce armed just before Continue cannot overwrite the arrival with stale state', async () => {
    renderAnonymousThenSignIn();

    fireEvent.click(screen.getByRole('button', { name: 'edit-profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'edit-profile' }));
    vi.advanceTimersByTime(800);

    // Edit once more, then navigate INSIDE the debounce window.
    fireEvent.click(screen.getByRole('button', { name: 'edit-profile' }));
    await clickAndFlush('next');

    // The stale timer's window elapses after the navigation has been recorded.
    vi.advanceTimersByTime(800);

    const stored = readAnonymousDraft();
    expect(stored?.currentStep).toBe(1);
    expect(stored?.stepStatuses?.[0]).toBe('completed');
  });

  /**
   * The transition effect must never be what CREATES an envelope — otherwise every
   * anonymous page view leaves a claimable (if empty) draft in the tab for
   * `stampAuthGate` to stamp. Note the envelope genuinely does appear on a Continue
   * click even with nothing typed, because `performSave`'s anonymous branch writes
   * unconditionally; that is pre-existing behaviour and not this effect's doing.
   */
  it('does not bring an envelope into being on mount — creation still belongs to the first real save', () => {
    renderAnonymousThenSignIn();

    expect(globalThis.sessionStorage.getItem('balo.expert-apply.anon-draft.v1')).toBeNull();
  });
});

describe('BAL-562 — a malformed stored slice cannot crash the restored wizard', () => {
  it('keeps the initializer shape guarantees when a stored slice is missing fields', () => {
    writeAnonymousDraft({
      v: 1,
      savedAt: new Date().toISOString(),
      currentStep: 0,
      maxReachedStep: 0,
      // An envelope from an older build: no `languages`, no `industryIds`, no booleans.
      steps: { profile: { yearStartedSalesforce: 2016 } },
    });

    renderHarness(null, null);

    // Restored value present, and the array the step maps over survived the merge.
    expect(screen.getByTestId('year').textContent).toBe('2016');
    expect(screen.getByTestId('languages').textContent).toBe('0');
  });

  /**
   * Rewritten after mutation-testing showed the first version was vacuous: it asserted
   * `languages`/`products` survived, which the MERGE already guarantees on its own, so
   * removing the guard left it green. What the guard uniquely prevents is state
   * pollution — spreading `['not','an','object']` mints keys `0`,`1`,`2`, and those
   * then serialize into the envelope and POST to `saveDraftAction` on flush.
   */
  it('drops a single key whose type contradicts the initializer, keeping the rest of the slice', () => {
    writeAnonymousDraft({
      v: 1,
      savedAt: new Date().toISOString(),
      currentStep: 0,
      maxReachedStep: 0,
      steps: {
        // `languages` is an array in every real slice. A string here is what turns
        // `languages.map(...)` into a crash — the field is dropped, the good sibling
        // value beside it is not.
        profile: { yearStartedSalesforce: 2016, languages: 'not-an-array' },
      },
    });

    renderHarness(null, null);

    expect(screen.getByTestId('year').textContent).toBe('2016');
    expect(screen.getByTestId('languages').textContent).toBe('0');
  });

  it('drops a slice that is not a plain object rather than spreading index keys into state', () => {
    writeAnonymousDraft({
      v: 1,
      savedAt: new Date().toISOString(),
      currentStep: 0,
      maxReachedStep: 0,
      steps: { profile: ['not', 'an', 'object'], products: 'nonsense' },
    });

    renderHarness(null, null);

    const keys = screen.getByTestId('profile-keys').textContent ?? '';
    expect(keys.split(',').filter((k) => /^\d+$/.test(k))).toEqual([]);
    // And the initializer's shape is untouched.
    expect(screen.getByTestId('year').textContent).toBe('unset');
    expect(screen.getByTestId('languages').textContent).toBe('0');
    expect(screen.getByTestId('products').textContent).toBe('none');
  });
});

describe('BAL-562 — bookkeeping writes must not count as activity (savedAt is the kiosk signal)', () => {
  // Older than AUTH_GATE_FLUSH_WINDOW_MS, younger than ANON_DRAFT_MAX_AGE_MS: an
  // application abandoned in this tab a while ago, still on disk.
  const ABANDONED_AT = new Date(Date.now() - 45 * 60 * 1000).toISOString();

  function seedAbandonedEnvelope(): void {
    writeAnonymousDraft({
      v: 1,
      savedAt: ABANDONED_AT,
      currentStep: 4,
      maxReachedStep: 5,
      stepStatuses: [
        'completed',
        'completed',
        'completed',
        'completed',
        'pending',
        'pending',
        'pending',
      ],
      steps: { profile: { yearStartedSalesforce: 2016 } },
    });
  }

  /**
   * THE REGRESSION PROBE for the interaction between the two fixes. The transition
   * effect fires on every restoring mount — the rail restore hands `setStepStatuses` a
   * freshly-allocated array, so its dep identity always changes — and it writes
   * `buildAnonymousEnvelope()`, which mints a new `savedAt`. That is the exact field
   * `stampAuthGate` measures. Let it mint, and a second person at this tab need only
   * reload before clicking "Log in" for the idle check to pass and the flush to hand
   * them the first person's application.
   */
  it('a restoring mount does not reset the idle clock', () => {
    seedAbandonedEnvelope();

    renderHarness(null, null);

    expect(screen.getByTestId('current').textContent).toBe('4'); // the restore ran
    expect(readAnonymousDraft()?.savedAt).toBe(ABANDONED_AT);
  });

  it('the draft therefore stays unclaimable after a reload — the mitigation survives', () => {
    seedAbandonedEnvelope();

    renderHarness(null, null);

    expect(stampAuthGate()).toBe(false);
    expect(readAnonymousDraft()?.authGateAt).toBeUndefined();
  });

  /**
   * A rail click routes through `saveIfDirty`, which writes nothing when the step is
   * clean — so the ONLY write here is the transition effect. Storage moving to step 0
   * proves it fired, which is what stops this test passing vacuously.
   */
  it('a rail click records the new position without counting as work', () => {
    seedAbandonedEnvelope();
    renderHarness(null, null);

    fireEvent.click(screen.getByRole('button', { name: 'rail-click-first' }));

    const stored = readAnonymousDraft();
    expect(stored?.currentStep).toBe(0); // the transition write definitely ran
    expect(stored?.savedAt).toBe(ABANDONED_AT); // and it was not treated as activity
    expect(stampAuthGate()).toBe(false);
  });

  it('but real work DOES refresh the clock, so an active applicant is never locked out of their own draft', async () => {
    seedAbandonedEnvelope();
    renderHarness(null, null);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'edit-profile' }));
    await user.click(screen.getByRole('button', { name: 'edit-profile' }));

    await waitFor(
      () => {
        expect(readAnonymousDraft()?.savedAt).not.toBe(ABANDONED_AT);
      },
      { timeout: 3000 }
    );
    expect(stampAuthGate()).toBe(true);
  });
});
