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
  const { currentStep, maxReachedStep, goNext, goPrevious, goToStep, updateStepData } = useWizard();
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
      <button type="button" onClick={() => goToStep(5)}>
        to-5
      </button>
      <button type="button" onClick={edit('profile', changedProfile)}>
        edit-profile
      </button>
      <button type="button" onClick={edit('terms', { termsAccepted: true })}>
        edit-terms
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

// Non-empty work history → `findFirstIncompleteStep` resolves the initial step to
// Terms (the last index).
const termsDraft = {
  profile: {
    id: 'profile-1',
    userId: 'user-1',
    applicationStatus: 'draft',
    yearStartedSalesforce: 2018,
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

  it('initializes maxReachedStep from a resumed draft and keeps every earlier step reachable', async () => {
    const user = userEvent.setup();
    renderHarness(termsDraft);

    expect(maxReached()).toBe('5');
    expect(current()).toBe('5');

    await user.click(screen.getByRole('button', { name: 'to-0' }));
    expect(current()).toBe('0');

    // Terms (index 5) is still reachable after jumping back.
    await user.click(screen.getByRole('button', { name: 'to-5' }));
    expect(current()).toBe('5');
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
    renderHarness(termsDraft); // starts on Terms (index 5)

    await user.click(screen.getByRole('button', { name: 'edit-terms' }));
    await user.click(screen.getByRole('button', { name: 'prev' }));

    await waitFor(() => expect(saveDraftMock).toHaveBeenCalled());
    // The FIRST save is for the step being left (terms), with its edited data.
    expect(saveDraftMock.mock.calls[0]?.[0]).toEqual({
      step: 'terms',
      data: { termsAccepted: true },
      expertProfileId: 'profile-1',
    });
    expect(current()).toBe('4');
  });

  it('does not save on exit when the current step is pristine', async () => {
    const user = userEvent.setup();
    renderHarness(termsDraft);

    await user.click(screen.getByRole('button', { name: 'prev' }));

    expect(current()).toBe('4');
    expect(saveDraftMock).not.toHaveBeenCalled();
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
    sendBeacon = vi.fn();
    Object.defineProperty(globalThis.navigator, 'sendBeacon', {
      value: sendBeacon,
      configurable: true,
      writable: true,
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
