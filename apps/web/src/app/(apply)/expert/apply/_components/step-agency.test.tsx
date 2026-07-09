import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { createRef } from 'react';
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

const mockResolve = vi.fn();
vi.mock('@/lib/auth/actions/resolve-expert-agency', () => ({
  resolveExpertAgencyAction: (...a: unknown[]) => mockResolve(...a),
}));

const mockLink = vi.fn();
vi.mock('../_actions/link-expert-agency', () => ({
  linkExpertAgencyAction: (...a: unknown[]) => mockLink(...a),
}));

// Stub motion to render plain elements (+ reduced-motion helper the step reads).
const MOTION_PROPS = new Set([
  'initial',
  'animate',
  'exit',
  'variants',
  'transition',
  'whileHover',
  'whileTap',
  'custom',
  'layout',
]);

vi.mock('motion/react', async () => {
  const React = await import('react');
  return {
    motion: new Proxy(
      {},
      {
        get: (_t: unknown, prop: string) =>
          React.forwardRef(function MotionStub(
            props: Record<string, unknown>,
            ref: React.Ref<unknown>
          ) {
            const filtered: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(props)) {
              if (!MOTION_PROPS.has(key)) filtered[key] = value;
            }
            return React.createElement(prop, { ...filtered, ref });
          }),
      }
    ),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    useReducedMotion: () => false,
  };
});

import { StepAgency } from './step-agency';
import { ExpertApplicationProvider } from './expert-application-context';
import { saveDraftAction } from '../_actions/save-draft';
import { track, EXPERT_AGENCY_EVENTS } from '@/lib/analytics';

const trackMock = vi.mocked(track);
const saveDraftMock = vi.mocked(saveDraftAction);

// ── Fixtures ─────────────────────────────────────────────────────

const referenceData: ReferenceData = {
  productsByCategory: [],
  supportTypes: [],
  certificationsByCategory: [],
  languages: [],
  industries: [],
  vertical: { id: 'vertical-1' } as ReferenceData['vertical'],
};

// Profile complete + agencyId null → the wizard lands on the agency step (index 1),
// so `expertProfileId` is 'profile-1' and the current step key is 'agency'.
const draft = {
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
  competencies: [],
  certifications: [],
  languages: [{ languageId: '44444444-4444-4444-4444-444444444444', proficiency: 'native' }],
  industries: [{ industryId: '55555555-5555-5555-5555-555555555555' }],
  workHistory: [],
} as unknown as ApplicationWithRelations;

function renderStep(): { container: HTMLElement } {
  const headingRef = createRef<HTMLHeadingElement>();
  const utils = render(
    <ExpertApplicationProvider
      draft={draft}
      referenceData={referenceData}
      user={{ id: 'user-1', email: 'jane@example.com' }}
    >
      <StepAgency headingRef={headingRef} />
    </ExpertApplicationProvider>
  );
  return { container: utils.container };
}

beforeEach(() => {
  vi.clearAllMocks();
  saveDraftMock.mockResolvedValue({ success: true } as Awaited<ReturnType<typeof saveDraftAction>>);
  mockLink.mockResolvedValue({ success: true, outcome: 'solo', agencyId: 'agency-solo' });
});

// ── Tests ────────────────────────────────────────────────────────

describe('StepAgency', () => {
  it('shows the loading state while the outcome is resolving', () => {
    // A never-resolving promise keeps the step in its loading phase.
    mockResolve.mockReturnValue(new Promise(() => {}));
    renderStep();
    expect(screen.getByText(/setting up your expert profile/i)).toBeInTheDocument();
  });

  it('renders the JOIN outcome with the earnings-routing note', async () => {
    mockResolve.mockResolvedValue({
      kind: 'join',
      agency: { id: 'agency-1', name: 'Lattice', memberCount: 4 },
    });
    renderStep();

    expect(
      await screen.findByRole('heading', { name: /you're joining lattice/i })
    ).toBeInTheDocument();
    // EarningsNote is present on the join path.
    expect(screen.getByText(/earnings from your balo work go to/i)).toBeInTheDocument();
    expect(screen.getByText(/4 colleagues are already here/i)).toBeInTheDocument();
  });

  it('renders the PROVISION outcome with the owner-framed earnings note', async () => {
    mockResolve.mockResolvedValue({ kind: 'provision', name: 'Acme' });
    renderStep();

    expect(
      await screen.findByRole('heading', { name: /set up your team on balo/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/you decide how they're shared/i)).toBeInTheDocument();
  });

  it('renders the SOLO outcome, NEVER says "agency", and shows NO earnings note', async () => {
    mockResolve.mockResolvedValue({ kind: 'solo' });
    const { container } = renderStep();

    expect(
      await screen.findByRole('heading', { name: /let's set up your expert profile/i })
    ).toBeInTheDocument();
    // ADR-1034 hard rule: the solo surface must not contain the word "agency".
    expect(container.textContent?.toLowerCase()).not.toContain('agency');
    // No earnings-routing note on the independent path.
    expect(screen.queryByText(/earnings/i)).toBeNull();
  });

  it('on Continue: writes, tracks the resolved outcome, and advances without a redundant save-draft', async () => {
    const user = userEvent.setup();
    mockResolve.mockResolvedValue({ kind: 'solo' });
    mockLink.mockResolvedValue({ success: true, outcome: 'solo', agencyId: 'agency-solo' });
    renderStep();

    const continueBtn = await screen.findByRole('button', { name: /continue/i });
    await user.click(continueBtn);

    await waitFor(() => expect(mockLink).toHaveBeenCalledWith({ expertProfileId: 'profile-1' }));
    expect(trackMock).toHaveBeenCalledWith(EXPERT_AGENCY_EVENTS.RESOLVED, { outcome: 'solo' });
    // BAL-356 fix: the agency step is self-advancing, so goNext skips the shared
    // validation + save entirely (the in-card linkExpertAgencyAction is the sole write).
    // Continue re-enables afterwards rather than staying stuck disabled.
    await waitFor(() => expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled());
    expect(saveDraftMock).not.toHaveBeenCalledWith(expect.objectContaining({ step: 'agency' }));
  });

  it('does not leave Continue permanently disabled when goNext resolves without unmounting (already_linked resume)', async () => {
    // Reproduces the stuck-busy defect: a returning already-linked expert clicks Continue,
    // linkExpertAgencyAction resolves success/already_linked, and goNext resolves while the
    // step is still mounted (a non-advance). The button must re-enable, not wedge on busy.
    const user = userEvent.setup();
    mockResolve.mockResolvedValue({ kind: 'solo' });
    mockLink.mockResolvedValue({ success: true, outcome: 'already_linked', agencyId: 'agency-9' });
    renderStep();

    const continueBtn = await screen.findByRole('button', { name: /continue/i });
    await user.click(continueBtn);

    await waitFor(() => expect(mockLink).toHaveBeenCalled());
    // No error banner, and Continue is enabled again (busy cleared by the mounted-guard reset).
    await waitFor(() => expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does NOT track the resolved event on an idempotent already_linked resume', async () => {
    const user = userEvent.setup();
    mockResolve.mockResolvedValue({ kind: 'solo' });
    mockLink.mockResolvedValue({ success: true, outcome: 'already_linked', agencyId: 'agency-9' });
    renderStep();

    const continueBtn = await screen.findByRole('button', { name: /continue/i });
    await user.click(continueBtn);

    await waitFor(() => expect(mockLink).toHaveBeenCalled());
    expect(trackMock).not.toHaveBeenCalledWith(EXPERT_AGENCY_EVENTS.RESOLVED, expect.anything());
  });

  it('shows an inline retry banner on a write failure and re-enables Continue', async () => {
    const user = userEvent.setup();
    mockResolve.mockResolvedValue({
      kind: 'join',
      agency: { id: 'a1', name: 'Lattice', memberCount: 2 },
    });
    mockLink.mockResolvedValueOnce({
      success: false,
      error: 'Something went wrong. Please try again.',
    });
    renderStep();

    const continueBtn = await screen.findByRole('button', { name: /continue/i });
    await user.click(continueBtn);

    // Inline role="alert" banner surfaces the error; no track; button retryable.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/something went wrong/i);
    expect(trackMock).not.toHaveBeenCalledWith(EXPERT_AGENCY_EVENTS.RESOLVED, expect.anything());

    // Retry in place — a second click fires the write again.
    mockLink.mockResolvedValueOnce({ success: true, outcome: 'join', agencyId: 'a1' });
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(mockLink).toHaveBeenCalledTimes(2));
  });

  it('has no accessibility violations on the solo outcome', async () => {
    mockResolve.mockResolvedValue({ kind: 'solo' });
    const { container } = renderStep();
    await screen.findByRole('heading', { name: /let's set up your expert profile/i });
    expect(await axe(container)).toHaveNoViolations();
  });
});
