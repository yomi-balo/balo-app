import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { ReferenceData } from '../_actions/load-draft';
import type { ApplicationWithRelations } from '@balo/db';

// ── Mocks ────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../_actions/save-draft', () => ({
  saveDraftAction: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../_actions/submit-application', () => ({
  submitApplicationAction: vi.fn().mockResolvedValue({ success: true }),
}));

import { ExpertApplicationProvider, useWizard } from './expert-application-context';
import { saveDraftAction } from '../_actions/save-draft';
import type { StepKey } from '../_actions/schemas';

const saveDraftMock = vi.mocked(saveDraftAction);

// ── Harness ──────────────────────────────────────────────────────

const changedProfile = {
  yearStartedSalesforce: 2019,
  isSalesforceMvp: false,
  isSalesforceCta: false,
  isCertifiedTrainer: false,
  languages: [],
  industryIds: [],
};

function Harness(): React.JSX.Element {
  const {
    currentStep,
    maxReachedStep,
    goNext,
    goPrevious,
    goToStep,
    updateStepData,
    registerValidation,
  } = useWizard();
  const edit = (step: StepKey, data: unknown) => (): void => updateStepData(step, data);
  return (
    <div>
      <span data-testid="current">{currentStep}</span>
      <span data-testid="max">{maxReachedStep}</span>
      <button type="button" onClick={() => void goNext()}>
        next
      </button>
      <button type="button" onClick={goPrevious}>
        prev
      </button>
      <button type="button" onClick={() => goToStep(0)}>
        to-0
      </button>
      <button type="button" onClick={() => goToStep(3)}>
        to-3
      </button>
      <button type="button" onClick={() => goToStep(6)}>
        to-6
      </button>
      <button type="button" onClick={edit('profile', changedProfile)}>
        edit-profile
      </button>
      <button type="button" onClick={edit('terms', { termsAccepted: true })}>
        edit-terms
      </button>
      {/* Simulate a stale validation left in the shared validationRef by a
          previously-mounted step (e.g. Terms' form.trigger returning false). */}
      <button type="button" onClick={() => registerValidation(async () => false)}>
        stale-invalid-validation
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

// Non-empty work history + a linked agency (BAL-356) → `findFirstIncompleteStep`
// resolves the initial step to Terms (the last index). Without `agencyId` the new
// agency gate would land the user on the agency step (index 1) instead.
const termsDraft = {
  profile: {
    id: 'profile-1',
    userId: 'user-1',
    applicationStatus: 'draft',
    yearStartedSalesforce: 2018,
    agencyId: '77777777-7777-7777-7777-777777777777',
    linkedinUrl: null,
    trailheadUrl: null,
    isSalesforceMvp: false,
    isSalesforceCta: false,
    isCertifiedTrainer: false,
  },
  competencies: [
    {
      id: 's1',
      productId: '11111111-1111-1111-1111-111111111111',
      supportTypeId: 'st-fix',
      proficiency: 7,
    },
  ],
  certifications: [
    {
      certificationId: '33333333-3333-3333-3333-333333333333',
      earnedAt: null,
      expiresAt: null,
      credentialUrl: null,
    },
  ],
  languages: [{ languageId: '44444444-4444-4444-4444-444444444444', proficiency: 'native' }],
  industries: [{ industryId: '55555555-5555-5555-5555-555555555555' }],
  workHistory: [
    {
      id: '66666666-6666-6666-6666-666666666666',
      role: 'Consultant',
      company: 'Acme',
      startedAt: new Date('2020-01-01'),
      endedAt: null,
      isCurrent: true,
      responsibilities: null,
    },
  ],
} as unknown as ApplicationWithRelations;

// Profile complete + agencyId null → findFirstIncompleteStep stops at the agency step
// (the new required gate at index 1), NOT products (which shifted to index 2).
const agencyGateDraft = {
  profile: {
    id: 'profile-1',
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
  competencies: [
    {
      id: 's1',
      productId: '11111111-1111-1111-1111-111111111111',
      supportTypeId: 'st',
      proficiency: 7,
    },
  ],
  certifications: [],
  languages: [{ languageId: '44444444-4444-4444-4444-444444444444', proficiency: 'native' }],
  industries: [{ industryId: '55555555-5555-5555-5555-555555555555' }],
  workHistory: [],
} as unknown as ApplicationWithRelations;

function renderHarness(draft: ApplicationWithRelations | null): void {
  render(
    <ExpertApplicationProvider
      draft={draft}
      referenceData={referenceData}
      user={{ id: 'user-1', email: 'jane@example.com' }}
    >
      <Harness />
    </ExpertApplicationProvider>
  );
}

function current(): string | null {
  return screen.getByTestId('current').textContent;
}
function maxReached(): string | null {
  return screen.getByTestId('max').textContent;
}

// jsdom's Blob has no `.text()` here — read it via FileReader instead.
function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (): void => resolve(String(reader.result));
    reader.onerror = (): void => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsText(blob);
  });
}

// ── Tests ────────────────────────────────────────────────────────

describe('expert-application navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveDraftMock.mockResolvedValue({ success: true } as Awaited<
      ReturnType<typeof saveDraftAction>
    >);
  });

  it('agency gate: a profile-complete draft with no linked agency lands on the agency step (index 1 of 7)', () => {
    renderHarness(agencyGateDraft);

    expect(current()).toBe('1');
    expect(maxReached()).toBe('1');
  });

  it('self-advancing step: goNext advances even when a stale validation would fail and save is not the gate', async () => {
    // BAL-356 regression: on the self-advancing agency step, goNext must NOT run the shared
    // (possibly stale) validationRef or a save — the in-card action owns the write. A stale
    // invalid validation + a failing save must not strand the step.
    const user = userEvent.setup();
    saveDraftMock.mockResolvedValue({ success: false, error: 'nope' } as Awaited<
      ReturnType<typeof saveDraftAction>
    >);
    renderHarness(agencyGateDraft); // lands on the agency step (index 1)

    expect(current()).toBe('1');

    // Simulate a stale validation left in the shared ref by a previously-mounted step.
    await user.click(screen.getByRole('button', { name: 'stale-invalid-validation' }));
    await user.click(screen.getByRole('button', { name: 'next' }));

    // Advances despite the false validation, and never calls save-draft for this step.
    await waitFor(() => expect(current()).toBe('2'));
    expect(saveDraftMock).not.toHaveBeenCalled();
  });

  it('initializes maxReachedStep from a resumed draft and keeps every earlier step reachable', async () => {
    const user = userEvent.setup();
    renderHarness(termsDraft);

    expect(maxReached()).toBe('6');
    expect(current()).toBe('6');

    await user.click(screen.getByRole('button', { name: 'to-0' }));
    expect(current()).toBe('0');

    // Terms (now index 6, after the agency insertion) is still reachable after jumping back.
    await user.click(screen.getByRole('button', { name: 'to-6' }));
    expect(current()).toBe('6');
  });

  it('blocks forward jumps past maxReachedStep and allows them once reached', async () => {
    const user = userEvent.setup();
    renderHarness(null);

    expect(current()).toBe('0');
    expect(maxReached()).toBe('0');

    // Step 3 has never been reached → jump is a no-op.
    await user.click(screen.getByRole('button', { name: 'to-3' }));
    expect(current()).toBe('0');

    // Advance to grow maxReachedStep to 1.
    await user.click(screen.getByRole('button', { name: 'next' }));
    await waitFor(() => expect(current()).toBe('1'));
    await waitFor(() => expect(maxReached()).toBe('1'));

    // Step 3 is still unreachable…
    await user.click(screen.getByRole('button', { name: 'to-3' }));
    expect(current()).toBe('1');

    // …but a back jump and a forward jump up to max both succeed.
    await user.click(screen.getByRole('button', { name: 'to-0' }));
    expect(current()).toBe('0');
    await user.click(screen.getByRole('button', { name: 'next' })); // grow max again via re-advance
    await waitFor(() => expect(current()).toBe('1'));
  });

  it('save-on-exit persists the LEAVING step (not the destination) before navigating', async () => {
    const user = userEvent.setup();
    renderHarness(termsDraft); // starts on Terms (index 6)

    await user.click(screen.getByRole('button', { name: 'edit-terms' }));
    await user.click(screen.getByRole('button', { name: 'prev' }));

    await waitFor(() => expect(saveDraftMock).toHaveBeenCalled());
    // The FIRST save is for the step being left (terms), with its edited data.
    expect(saveDraftMock.mock.calls[0]?.[0]).toEqual({
      step: 'terms',
      data: { termsAccepted: true },
      expertProfileId: 'profile-1',
    });
    expect(current()).toBe('5');
  });

  it('does not save on exit when the current step is pristine', async () => {
    const user = userEvent.setup();
    renderHarness(termsDraft);

    await user.click(screen.getByRole('button', { name: 'prev' }));

    expect(current()).toBe('5');
    expect(saveDraftMock).not.toHaveBeenCalled();
  });

  it('does not save when hopping between untouched steps of a resumed draft (BAL-342)', async () => {
    // Every step's baseline is seeded at mount from the persisted draft, so leaving a
    // step nobody edited is never dirty — not even on its FIRST departure. Seeding only
    // the initial step left this hop firing a save of data already in the DB.
    const user = userEvent.setup();
    renderHarness(termsDraft); // starts on Terms (index 6), max reached 6

    await user.click(screen.getByRole('button', { name: 'to-0' }));
    expect(current()).toBe('0');

    await user.click(screen.getByRole('button', { name: 'to-6' }));
    expect(current()).toBe('6');

    expect(saveDraftMock).not.toHaveBeenCalled();
  });

  it('does not redundantly re-save an unchanged step on later hops (BAL-342)', async () => {
    // Per-step baselines: with a single shared snapshot, leaving ANY step after the
    // first save compared against the previously-saved step's data and always looked
    // dirty. Each step must be measured against its own last-saved snapshot.
    const user = userEvent.setup();
    renderHarness(termsDraft); // starts on Terms (index 6), seeded clean

    // Hop 1 — leave a pristine Terms. Clean, so no save.
    await user.click(screen.getByRole('button', { name: 'to-0' }));
    expect(current()).toBe('0');
    expect(saveDraftMock).not.toHaveBeenCalled();

    // Edit Profile, then leave it — the one legitimate save in this whole run.
    await user.click(screen.getByRole('button', { name: 'edit-profile' }));
    await user.click(screen.getByRole('button', { name: 'to-6' }));
    await waitFor(() => expect(saveDraftMock).toHaveBeenCalledTimes(1));
    expect(saveDraftMock.mock.calls[0]?.[0]).toMatchObject({ step: 'profile' });
    expect(current()).toBe('6');

    // Hop 2 — leave Terms again, still untouched. Under the old shared baseline this
    // compared Terms' data to Profile's snapshot and fired a redundant save.
    await user.click(screen.getByRole('button', { name: 'to-0' }));
    expect(current()).toBe('0');

    // Hop 3 — leave Profile again with no further edits: its own baseline matches.
    await user.click(screen.getByRole('button', { name: 'to-6' }));
    expect(current()).toBe('6');

    expect(saveDraftMock).toHaveBeenCalledTimes(1);
  });
});

// ── pagehide / visibilitychange beacon flush (explicit AC) ───────

describe('expert-application unload flush', () => {
  let sendBeacon: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    saveDraftMock.mockResolvedValue({ success: true } as Awaited<
      ReturnType<typeof saveDraftAction>
    >);
    sendBeacon = vi.fn().mockReturnValue(true);
    Object.defineProperty(globalThis.navigator, 'sendBeacon', {
      value: sendBeacon,
      configurable: true,
      writable: true,
    });
  });

  // Several tests stamp `visibilityState`; restore it so the block stays order-independent.
  afterEach(() => {
    Object.defineProperty(globalThis.document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
  });

  it('does not beacon when the step is pristine on pagehide', () => {
    renderHarness(null);

    globalThis.dispatchEvent(new Event('pagehide'));

    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it('beacons the unsaved step to the flush endpoint on pagehide', async () => {
    const user = userEvent.setup();
    renderHarness(null);

    await user.click(screen.getByRole('button', { name: 'edit-profile' }));
    globalThis.dispatchEvent(new Event('pagehide'));

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, blob] = sendBeacon.mock.calls[0] ?? [];
    expect(url).toBe('/api/expert/apply/flush-draft');
    expect(blob).toBeInstanceOf(Blob);
    const text = await readBlobText(blob as Blob);
    expect(JSON.parse(text)).toEqual({ step: 'profile', data: changedProfile });
  });

  it('does not re-flush the same payload when a live tab is backgrounded twice (BAL-342)', async () => {
    const user = userEvent.setup();
    renderHarness(null);

    await user.click(screen.getByRole('button', { name: 'edit-profile' }));

    Object.defineProperty(globalThis.document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    globalThis.document.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);

    // The tab never unloaded — backgrounding it again with no further edits must not
    // re-send an identical payload, because the queued beacon recorded an ATTEMPT for
    // this step. Its real saved baseline is deliberately untouched — see the tests below,
    // which prove the step is still re-savable and still re-flushable.
    globalThis.document.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
  });

  it('still saves a step whose beacon was only queued, never confirmed (BAL-342)', async () => {
    // sendBeacon returning true means "queued", not "stored" — the request can still be
    // dropped, or answered 401/500 unobserved. The step's real baseline must therefore be
    // untouched, so the next navigation re-saves it rather than silently losing the edit.
    const user = userEvent.setup();
    renderHarness(termsDraft); // starts on Terms (index 6)

    await user.click(screen.getByRole('button', { name: 'edit-terms' }));

    Object.defineProperty(globalThis.document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    globalThis.document.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);

    // The tab comes back — it never unloaded, so nothing is confirmed.
    Object.defineProperty(globalThis.document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    globalThis.document.dispatchEvent(new Event('visibilitychange'));

    await user.click(screen.getByRole('button', { name: 'prev' }));

    await waitFor(() => expect(saveDraftMock).toHaveBeenCalledTimes(1));
    expect(saveDraftMock.mock.calls[0]?.[0]).toMatchObject({
      step: 'terms',
      data: { termsAccepted: true },
    });
  });

  it('lets a real save through while still hidden — save paths ignore beacon attempts (BAL-342)', async () => {
    // Load-bearing asymmetry: `saveIfDirty` / `scheduleIdleSave` measure against the
    // SAVED baseline only, never against `beaconAttemptByStepRef`. Folding the attempt
    // guard into them (an easy good-faith "DRY" refactor) would resurrect the data-loss
    // path, so pin it here with no intervening `visible` transition to clear the attempt.
    const user = userEvent.setup();
    renderHarness(termsDraft);

    await user.click(screen.getByRole('button', { name: 'edit-terms' }));

    Object.defineProperty(globalThis.document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    globalThis.document.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);

    // Still hidden, attempt still on record — a real navigation must save anyway.
    await user.click(screen.getByRole('button', { name: 'prev' }));

    await waitFor(() => expect(saveDraftMock).toHaveBeenCalledTimes(1));
    expect(saveDraftMock.mock.calls[0]?.[0]).toMatchObject({ step: 'terms' });
  });

  it('re-flushes after the tab is shown again, since nothing was ever confirmed (BAL-342)', async () => {
    const user = userEvent.setup();
    renderHarness(null);

    await user.click(screen.getByRole('button', { name: 'edit-profile' }));

    const hide = (): void => {
      Object.defineProperty(globalThis.document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      });
      globalThis.document.dispatchEvent(new Event('visibilitychange'));
    };
    const show = (): void => {
      Object.defineProperty(globalThis.document, 'visibilityState', {
        value: 'visible',
        configurable: true,
      });
      globalThis.document.dispatchEvent(new Event('visibilitychange'));
    };

    hide();
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    hide(); // still hidden, identical payload → suppressed
    expect(sendBeacon).toHaveBeenCalledTimes(1);

    show(); // proves the tab survived → the queued attempt is no longer trustworthy
    hide();
    expect(sendBeacon).toHaveBeenCalledTimes(2);
  });

  it('does not suppress a re-flush when sendBeacon refuses the payload (BAL-342)', async () => {
    // A false return means the UA rejected it outright (e.g. over the queue quota) —
    // nothing was queued, so the next background must try again.
    const user = userEvent.setup();
    sendBeacon.mockReturnValue(false);
    renderHarness(null);

    await user.click(screen.getByRole('button', { name: 'edit-profile' }));

    globalThis.dispatchEvent(new Event('pagehide'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    globalThis.dispatchEvent(new Event('pagehide'));
    expect(sendBeacon).toHaveBeenCalledTimes(2);
  });

  it('beacons on visibilitychange when the document becomes hidden', async () => {
    const user = userEvent.setup();
    renderHarness(null);

    await user.click(screen.getByRole('button', { name: 'edit-profile' }));

    Object.defineProperty(globalThis.document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    globalThis.document.dispatchEvent(new Event('visibilitychange'));

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(sendBeacon.mock.calls[0]?.[0]).toBe('/api/expert/apply/flush-draft');
  });
});

// ── keepalive fetch fallback when sendBeacon is unavailable ───────

describe('expert-application unload flush — sendBeacon fallback', () => {
  let originalSendBeacon: typeof globalThis.navigator.sendBeacon | undefined;
  let originalFetch: typeof globalThis.fetch | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    saveDraftMock.mockResolvedValue({ success: true } as Awaited<
      ReturnType<typeof saveDraftAction>
    >);

    originalSendBeacon = globalThis.navigator.sendBeacon;
    originalFetch = globalThis.fetch;

    // Force the sendBeacon-unavailable branch of the flush effect.
    Object.defineProperty(globalThis.navigator, 'sendBeacon', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    fetchMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis.navigator, 'sendBeacon', {
      value: originalSendBeacon,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      configurable: true,
      writable: true,
    });
  });

  it('keepalive-fetches the flush endpoint on pagehide when sendBeacon is unavailable', async () => {
    const user = userEvent.setup();
    renderHarness(null);

    await user.click(screen.getByRole('button', { name: 'edit-profile' }));
    globalThis.dispatchEvent(new Event('pagehide'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/expert/apply/flush-draft');
    expect(options).toMatchObject({ keepalive: true, method: 'POST' });
  });
});
