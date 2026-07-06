import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { ReferenceData } from '../_actions/load-draft';
import type { ApplicationWithRelations } from '@balo/db';

// ── Mocks ────────────────────────────────────────────────────────

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

import { WizardActionBar } from './wizard-action-bar';
import { ExpertApplicationProvider } from './expert-application-context';
import { saveDraftAction } from '../_actions/save-draft';
import { toast } from 'sonner';
import { track, EXPERT_EVENTS } from '@/lib/analytics';

const saveDraftMock = vi.mocked(saveDraftAction);
const toastSuccess = vi.mocked(toast.success);
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

// A fully-hydrated draft with non-empty work history so `findFirstIncompleteStep`
// resolves the initial step to Terms (the last index).
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

function renderBar(draft: ApplicationWithRelations | null): void {
  render(
    <ExpertApplicationProvider
      draft={draft}
      referenceData={referenceData}
      user={{ id: 'user-1', email: 'jane@example.com' }}
    >
      <WizardActionBar />
    </ExpertApplicationProvider>
  );
}

// ── Tests ────────────────────────────────────────────────────────

describe('WizardActionBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveDraftMock.mockResolvedValue({ success: true } as Awaited<
      ReturnType<typeof saveDraftAction>
    >);
  });

  it('shows Save & exit on both viewports and no Previous on the first step', () => {
    renderBar(null);

    // Desktop + mobile each render a Save & exit button.
    expect(screen.getAllByRole('button', { name: /save & exit/i }).length).toBeGreaterThanOrEqual(
      2
    );
    // The dead disabled-Previous wiring is gone on step 1.
    expect(screen.queryByRole('button', { name: /previous/i })).toBeNull();
  });

  it('clicking Save & exit saves the draft, tracks abandon, toasts, and routes to /dashboard', async () => {
    const user = userEvent.setup();
    renderBar(null);

    const [saveExit] = screen.getAllByRole('button', { name: /save & exit/i });
    if (saveExit === undefined) throw new Error('Save & exit button not rendered');
    await user.click(saveExit);

    await waitFor(() => expect(saveDraftMock).toHaveBeenCalled());
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/dashboard'));
    expect(toastSuccess).toHaveBeenCalledWith('Your progress has been saved. Come back anytime!');
    expect(trackMock).toHaveBeenCalledWith(
      EXPERT_EVENTS.APPLICATION_ABANDONED,
      expect.objectContaining({ last_step: 'profile' })
    );
  });

  it('does not navigate, toast success, or track abandon when the save fails', async () => {
    const user = userEvent.setup();
    saveDraftMock.mockResolvedValue({
      success: false,
      expertProfileId: '',
      error: 'Failed to save. Please try again.',
    } as Awaited<ReturnType<typeof saveDraftAction>>);
    renderBar(null);

    const [saveExit] = screen.getAllByRole('button', { name: /save & exit/i });
    if (saveExit === undefined) throw new Error('Save & exit button not rendered');
    await user.click(saveExit);

    await waitFor(() => expect(saveDraftMock).toHaveBeenCalled());

    // Failed save keeps the user on the page: no navigation, no false success toast,
    // and no abandon analytics event.
    expect(routerPush).not.toHaveBeenCalledWith('/dashboard');
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalledWith(
      EXPERT_EVENTS.APPLICATION_ABANDONED,
      expect.anything()
    );
  });

  it('keeps Save & exit available on the Terms step where Next is hidden', () => {
    renderBar(termsDraft);

    expect(screen.getAllByRole('button', { name: /save & exit/i }).length).toBeGreaterThanOrEqual(
      1
    );
    // Terms is the last step → no Next button.
    expect(screen.queryByRole('button', { name: /next/i })).toBeNull();
    // Not the first step → Previous is available.
    expect(screen.getAllByRole('button', { name: /previous/i }).length).toBeGreaterThanOrEqual(1);
  });
});
