import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/utils';
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

const authModalOpen = vi.fn();
vi.mock('@/hooks/use-auth-modal', () => ({
  useAuthModal: () => ({ open: authModalOpen }),
}));

// HIGH 4 (FIX round) — wraps the REAL `writeAnonymousDraft` in a spy (rather than
// stubbing it out) so `sessionStorage`-based assertions elsewhere keep working,
// while giving us `.mock.invocationCallOrder` to prove ordering against
// `authModalOpen` WITHOUT racing the 800ms `scheduleAnonymousSave` debounce — the
// exact false-green the reviewer found (a `waitFor` with its default 1000ms
// budget let the debounced write land before the assertion ran, so deleting the
// synchronous `saveAnonymousDraftNow()` call in step-terms.tsx still passed).
vi.mock('@/lib/expert-apply/anonymous-draft', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/expert-apply/anonymous-draft')>();
  return { ...actual, writeAnonymousDraft: vi.fn(actual.writeAnonymousDraft) };
});

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
import { WizardActionBar } from './wizard-action-bar';
import { ExpertApplicationProvider } from './expert-application-context';
import { submitApplicationAction } from '../_actions/submit-application';
import { writeAnonymousDraft } from '@/lib/expert-apply/anonymous-draft';
import { toast } from 'sonner';
import { track, EXPERT_EVENTS } from '@/lib/analytics';

const submitMock = vi.mocked(submitApplicationAction);
const toastError = vi.mocked(toast.error);
const trackMock = vi.mocked(track);
const writeAnonymousDraftMock = vi.mocked(writeAnonymousDraft);

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
// `submitApplication` actually calls the action), plus competencies/certs and a
// non-empty work-history entry so `findFirstIncompleteStep` resolves the initial
// step to Terms (the last index) — that makes `isLast` true so the relocated
// Submit button renders in the WizardActionBar. Also drives the summary ternaries
// (e.g. `productsData.productIds?.length`) so real counts render rather than "None".
const draft = {
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

function renderStep(draftArg: ApplicationWithRelations | null): void {
  const headingRef = createRef<HTMLHeadingElement>();
  render(
    <ExpertApplicationProvider
      draft={draftArg}
      referenceData={referenceData}
      user={{ id: 'user-1' }}
    >
      <StepTerms headingRef={headingRef} />
      <WizardActionBar />
    </ExpertApplicationProvider>
  );
}

// BAL-502 §22.4 — the anonymous submit-gate variant: `user={null}`. Reuses the same
// filled-out `draft` fixture as `renderStep` so `resolveInitialStep` lands on the
// Terms step (last index) and the relocated Submit button renders — `isAnonymous`
// is driven purely by `user`, independent of `draft` (a production render never
// combines a non-null draft with a null user; this is a test-only shortcut to reach
// the last step without simulating six steps of navigation).
function renderAnonymousStep(): void {
  const headingRef = createRef<HTMLHeadingElement>();
  render(
    <ExpertApplicationProvider draft={draft} referenceData={referenceData} user={null}>
      <StepTerms headingRef={headingRef} />
      <WizardActionBar />
    </ExpertApplicationProvider>
  );
}

// ── Tests ────────────────────────────────────────────────────────

describe('StepTerms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    submitMock.mockResolvedValue({ success: true });
    globalThis.sessionStorage.clear();
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

  it('surfaces the terms validation message and does not submit when the box is unchecked', async () => {
    const user = userEvent.setup();
    // jsdom has no scrollIntoView impl — the handler calls it on the invalid path.
    // Stub it, then restore so the mock never leaks into later tests in this file.
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    try {
      renderStep(draft);

      // Click the relocated Submit (desktop bar is [0]) WITHOUT checking the box.
      const [submitBtn] = screen.getAllByRole('button', { name: /submit application/i });
      if (submitBtn === undefined) throw new Error('Submit button not rendered');
      await user.click(submitBtn);

      // The zod message surfaces via <FormMessage/>, the action is never called,
      // and the checkbox is scrolled into view.
      expect(await screen.findByText('You must accept the terms to continue')).toBeInTheDocument();
      expect(submitMock).not.toHaveBeenCalled();
      expect(scrollIntoView).toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('submits successfully, tracks the event, and redirects after the success hold', async () => {
    const user = userEvent.setup();
    submitMock.mockResolvedValue({ success: true });

    renderStep(draft);

    await user.click(screen.getByRole('checkbox'));
    const [submitBtn] = screen.getAllByRole('button', { name: /submit application/i });
    if (submitBtn === undefined) throw new Error('Submit button not rendered');
    await user.click(submitBtn);

    // The action runs with the resolved expert profile id from the hydrated draft.
    await waitFor(() => expect(submitMock).toHaveBeenCalledWith('profile-1'));

    // Success state surfaces and the submitted event fires with the real counts.
    await waitFor(() => expect(screen.getAllByText(/submitted!/i)[0]).toBeInTheDocument());
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
    const [submitBtn] = screen.getAllByRole('button', { name: /submit application/i });
    if (submitBtn === undefined) throw new Error('Submit button not rendered');
    await user.click(submitBtn);

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Server exploded'));
    expect(trackMock).toHaveBeenCalledWith(
      EXPERT_EVENTS.APPLICATION_SUBMIT_FAILED,
      expect.objectContaining({ error_message: 'Server exploded' })
    );
    // Button returns to its idle (re-submittable) label.
    expect(
      screen.getAllByRole('button', { name: /submit application/i }).length
    ).toBeGreaterThanOrEqual(1);
  });

  it('recovers when the submit action throws: resets state, toasts, and stays retryable', async () => {
    const user = userEvent.setup();
    // The action rejects (e.g. network failure) instead of returning a result —
    // the catch path must release the latch and return the button to idle so the
    // never-disabled button can never lock the user out.
    submitMock.mockRejectedValueOnce(new Error('network down'));

    renderStep(draft);

    await user.click(screen.getByRole('checkbox'));
    const [submitBtn] = screen.getAllByRole('button', { name: /submit application/i });
    if (submitBtn === undefined) throw new Error('Submit button not rendered');
    await user.click(submitBtn);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'Something went wrong submitting your application. Please try again.'
      )
    );
    expect(trackMock).toHaveBeenCalledWith(
      EXPERT_EVENTS.APPLICATION_SUBMIT_FAILED,
      expect.objectContaining({ error_message: 'network down' })
    );
    // Latch released → the button is back to its idle, re-submittable label.
    expect(screen.getAllByText('Submit Application').length).toBeGreaterThanOrEqual(1);
  });

  it('guards against double-submit: two synchronous clicks fire exactly one server mutation', async () => {
    const user = userEvent.setup();
    submitMock.mockResolvedValue({ success: true });

    renderStep(draft);

    // Accept the terms so form validation passes on submit.
    await user.click(screen.getByRole('checkbox'));

    const [submitBtn] = screen.getAllByRole('button', { name: /submit application/i });
    if (submitBtn === undefined) throw new Error('Submit button not rendered');

    // Two SYNCHRONOUS dispatches with no await between them: the second lands
    // inside the first handler's `await form.trigger()` microtask window, before
    // the reactive 'submitting' state can commit. The synchronous ref latch must
    // swallow the second one so the server mutation runs exactly once.
    fireEvent.click(submitBtn);
    fireEvent.click(submitBtn);

    await waitFor(() => expect(submitMock).toHaveBeenCalled());
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('routes to the failing step and toasts when submit returns a failingStep', async () => {
    const user = userEvent.setup();
    submitMock.mockResolvedValue({ success: false, failingStep: 'profile' });

    renderStep(draft);

    await user.click(screen.getByRole('checkbox'));
    const [submitBtn] = screen.getAllByRole('button', { name: /submit application/i });
    if (submitBtn === undefined) throw new Error('Submit button not rendered');
    await user.click(submitBtn);

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

  // ── Anonymous submit gate (BAL-502 §22.4) ─────────────────────────

  describe('anonymous submit gate', () => {
    it('renders the honest "Sign in to submit" label, never "Submit Application", for an anonymous visitor', () => {
      renderAnonymousStep();
      expect(screen.queryByRole('button', { name: /submit application/i })).toBeNull();
      expect(
        screen.getAllByRole('button', { name: /sign in to submit/i }).length
      ).toBeGreaterThanOrEqual(1);
    });

    // HIGH 4 (FIX round) — the reviewer PROVED this test was a false green:
    // deleting `saveAnonymousDraftNow()` from step-terms.tsx still passed it,
    // because the checkbox click ALSO schedules `scheduleAnonymousSave`'s 800ms
    // debounce, and `waitFor`'s DEFAULT 1000ms budget let that debounced write
    // land before the `sessionStorage` assertion ran. This version instead
    // compares `.mock.invocationCallOrder` between the (spied, still-real)
    // `writeAnonymousDraft` and `authModalOpen` — an ORDER proof, not a timing
    // race, so it cannot be satisfied by a write that happens to land later.
    //
    // Verified by deleting `saveAnonymousDraftNow();` at step-terms.tsx:133 and
    // re-running this test: it FAILS (`writeAnonymousDraftMock` is never called
    // by the time `authModalOpen` fires — the debounced write is scheduled but
    // hasn't landed within the click's synchronous window). Restored afterward.
    it('calls writeAnonymousDraft strictly BEFORE opening the auth modal (call-order proof), and never calls submitApplicationAction', async () => {
      const user = userEvent.setup();
      renderAnonymousStep();

      await user.click(screen.getByRole('checkbox'));
      const [submitBtn] = screen.getAllByRole('button', { name: /sign in to submit/i });
      if (submitBtn === undefined) throw new Error('Submit button not rendered');

      expect(globalThis.sessionStorage.getItem('balo.expert-apply.anon-draft.v1')).toBeNull();
      await user.click(submitBtn);

      await waitFor(() => expect(authModalOpen).toHaveBeenCalled());
      expect(writeAnonymousDraftMock).toHaveBeenCalled();
      expect(globalThis.sessionStorage.getItem('balo.expert-apply.anon-draft.v1')).not.toBeNull();

      const [writeOrder] = writeAnonymousDraftMock.mock.invocationCallOrder;
      const [openOrder] = authModalOpen.mock.invocationCallOrder;
      if (writeOrder === undefined || openOrder === undefined) {
        throw new Error('expected both mocks to have been invoked');
      }
      expect(writeOrder).toBeLessThan(openOrder);

      expect(authModalOpen).toHaveBeenCalledTimes(1);
      expect(submitMock).not.toHaveBeenCalled();
    });

    it('opens the auth modal with the unified entry (no defaultStep) and tracks the auth-gate event', async () => {
      const user = userEvent.setup();
      renderAnonymousStep();

      await user.click(screen.getByRole('checkbox'));
      const [submitBtn] = screen.getAllByRole('button', { name: /sign in to submit/i });
      if (submitBtn === undefined) throw new Error('Submit button not rendered');
      await user.click(submitBtn);

      await waitFor(() => expect(authModalOpen).toHaveBeenCalled());
      const [openArgs] = authModalOpen.mock.calls[0] as [Record<string, unknown>];
      expect(openArgs).not.toHaveProperty('defaultStep');
      expect(typeof openArgs.onSuccess).toBe('function');

      expect(trackMock).toHaveBeenCalledWith(
        EXPERT_EVENTS.APPLICATION_AUTH_GATE_REACHED,
        expect.objectContaining({ last_step: 'terms' })
      );
    });

    it('still validates the terms checkbox before gating — an unchecked box shows the zod message and never opens the modal', async () => {
      const user = userEvent.setup();
      const originalScrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = vi.fn();

      try {
        renderAnonymousStep();
        const [submitBtn] = screen.getAllByRole('button', { name: /sign in to submit/i });
        if (submitBtn === undefined) throw new Error('Submit button not rendered');
        await user.click(submitBtn);

        expect(
          await screen.findByText('You must accept the terms to continue')
        ).toBeInTheDocument();
        expect(authModalOpen).not.toHaveBeenCalled();
      } finally {
        Element.prototype.scrollIntoView = originalScrollIntoView;
      }
    });

    // WARNING 7 (FIX round) — the failure must be surfaced BEFORE the visitor
    // commits to signing up, not discovered afterward with an empty resume.
    it('surfaces a writeAnonymousDraft failure at the gate — blocks the modal, toasts, and never tracks the auth-gate event', async () => {
      const user = userEvent.setup();
      writeAnonymousDraftMock.mockReturnValueOnce(false);
      renderAnonymousStep();

      await user.click(screen.getByRole('checkbox'));
      const [submitBtn] = screen.getAllByRole('button', { name: /sign in to submit/i });
      if (submitBtn === undefined) throw new Error('Submit button not rendered');
      await user.click(submitBtn);

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(expect.stringContaining("couldn't save"))
      );
      expect(authModalOpen).not.toHaveBeenCalled();
      expect(trackMock).not.toHaveBeenCalledWith(
        EXPERT_EVENTS.APPLICATION_AUTH_GATE_REACHED,
        expect.anything()
      );
    });
  });
});
