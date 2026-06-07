import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import type { ReferenceData } from '../_actions/load-draft';
import type { ApplicationWithRelations } from '@balo/db';

// ── Mocks ────────────────────────────────────────────────────────

// Shared router push spy so success-path redirect can be asserted.
const routerPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: routerPush }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../_actions/save-draft', () => ({
  saveDraftAction: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../_actions/submit-application', () => ({
  submitApplicationAction: vi.fn().mockResolvedValue({ success: true }),
}));

// Stub motion to render plain elements.
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
  };
});

import { StepTerms } from './step-terms';
import { ExpertApplicationProvider } from './expert-application-context';
import { submitApplicationAction } from '../_actions/submit-application';
import { toast } from 'sonner';
import { track, EXPERT_EVENTS } from '@/lib/analytics';

const submitMock = vi.mocked(submitApplicationAction);
const toastError = vi.mocked(toast.error);
const trackMock = vi.mocked(track);

// ── Fixtures ─────────────────────────────────────────────────────

const referenceData: ReferenceData = {
  productsByCategory: [],
  supportTypes: [],
  certificationsByCategory: [],
  languages: [],
  industries: [],
  vertical: { id: 'vertical-1' } as ReferenceData['vertical'],
};

// A draft with a profile id (so the provider's `expertProfileId` is non-null and
// `submitApplication` actually calls the action), plus competencies/certs/work-history
// so the summary build (incl. the `productsData.productIds?.length` ternary at
// lines 137-138) renders real counts rather than "None".
const draft = {
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
    {
      id: 's2',
      productId: '22222222-2222-2222-2222-222222222222',
      supportTypeId: 'st-fix',
      proficiency: 5,
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
  workHistory: [],
} as unknown as ApplicationWithRelations;

function renderStep(draftArg: ApplicationWithRelations | null): void {
  const headingRef = createRef<HTMLHeadingElement>();
  render(
    <ExpertApplicationProvider
      draft={draftArg}
      referenceData={referenceData}
      user={{ id: 'user-1', email: 'jane@example.com' }}
    >
      <StepTerms headingRef={headingRef} />
    </ExpertApplicationProvider>
  );
}

// ── Tests ────────────────────────────────────────────────────────

describe('StepTerms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    submitMock.mockResolvedValue({ success: true });
  });

  it('renders the terms heading and the agreement checkbox', () => {
    renderStep(draft);
    expect(screen.getByRole('heading', { name: /terms & conditions/i })).toBeInTheDocument();
    expect(screen.getByText(/i have read and agree/i)).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
  });

  it('builds the application summary with real counts (exercises the summaryItems ternaries)', () => {
    // Hydrated draft → productsData.productIds has 2 ids, so the ternary at
    // lines 137-138 renders "2 selected" rather than "None".
    renderStep(draft);
    expect(screen.getByText('Products')).toBeInTheDocument();
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.getByText('1 added')).toBeInTheDocument(); // certifications
    expect(screen.getByText('1 languages')).toBeInTheDocument();
    expect(screen.getByText('1 selected')).toBeInTheDocument(); // industries
  });

  it('renders "None"/"Skipped" placeholders when the draft is empty', () => {
    renderStep(null);
    // No draft → empty product/cert/etc. arrays → placeholder values render.
    expect(screen.getAllByText('None').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Skipped').length).toBeGreaterThan(0);
  });

  it('keeps the submit button disabled until the terms are accepted', () => {
    renderStep(draft);
    expect(screen.getByRole('button', { name: /submit application/i })).toBeDisabled();
  });

  it('submits successfully, tracks the event, and redirects after the success hold', async () => {
    const user = userEvent.setup();
    submitMock.mockResolvedValue({ success: true });

    renderStep(draft);

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /submit application/i }));

    // The action runs with the resolved expert profile id from the hydrated draft.
    await waitFor(() => expect(submitMock).toHaveBeenCalledWith('profile-1'));

    // Success state surfaces and the submitted event fires with the real counts.
    await waitFor(() => expect(screen.getByText(/submitted!/i)).toBeInTheDocument());
    expect(trackMock).toHaveBeenCalledWith(
      EXPERT_EVENTS.APPLICATION_SUBMITTED,
      expect.objectContaining({ products_count: 2, certs_count: 1 })
    );

    // Redirect is deferred ~1.2s after success; wait for it on real timers.
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/expert/apply/success'), {
      timeout: 3000,
    });
  });

  it('shows a generic error toast and tracks the failure when submit returns success:false', async () => {
    const user = userEvent.setup();
    submitMock.mockResolvedValue({ success: false, error: 'Server exploded' });

    renderStep(draft);

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /submit application/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Server exploded'));
    expect(trackMock).toHaveBeenCalledWith(
      EXPERT_EVENTS.APPLICATION_SUBMIT_FAILED,
      expect.objectContaining({ error_message: 'Server exploded' })
    );
    // Button returns to its idle (re-submittable) label.
    expect(screen.getByRole('button', { name: /submit application/i })).toBeInTheDocument();
  });

  it('routes to the failing step and toasts when submit returns a failingStep', async () => {
    const user = userEvent.setup();
    submitMock.mockResolvedValue({ success: false, failingStep: 'profile' });

    renderStep(draft);

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /submit application/i }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Some fields need your attention. We've taken you to the first one."
      )
    );
    expect(trackMock).toHaveBeenCalledWith(
      EXPERT_EVENTS.APPLICATION_SUBMIT_FAILED,
      expect.objectContaining({ error_message: 'Unknown error' })
    );
  });
});
