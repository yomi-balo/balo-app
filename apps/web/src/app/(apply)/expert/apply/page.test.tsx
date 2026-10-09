import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import type { SessionUser } from '@/lib/auth/session';
import type { ReferenceData } from '@/lib/expert-apply/reference-data';
import type { ApplicationWithRelations } from '@balo/db';

// redirect() throws in real Next (NEXT_REDIRECT) to short-circuit the render —
// mirror that so control flow stops exactly where it would in production.
const { mockRedirect, mockGetCurrentUser, mockLoadReferenceData, mockLoadDraftAction } = vi.hoisted(
  () => ({
    mockRedirect: vi.fn((url: string): never => {
      throw new Error(`REDIRECT:${url}`);
    }),
    mockGetCurrentUser: vi.fn(),
    mockLoadReferenceData: vi.fn(),
    mockLoadDraftAction: vi.fn(),
  })
);

const mockPlatformSettingsGet = vi.fn();

vi.mock('next/navigation', () => ({ redirect: mockRedirect }));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('@/lib/expert-apply/reference-data', () => ({
  loadReferenceData: mockLoadReferenceData,
}));
vi.mock('./_actions/load-draft', () => ({ loadDraftAction: mockLoadDraftAction }));
vi.mock('@balo/db', () => ({
  platformSettingsRepository: { get: (...a: unknown[]) => mockPlatformSettingsGet(...a) },
}));

// Stub the wizard so this stays a page-level test (its own suite covers the
// wizard/context internals). Surface `user`/`draft`/`referenceData` as text so
// each test can assert exactly what the page passed down — including the
// anti-PII-leak guard below.
vi.mock('./_components/expert-application-wizard', () => ({
  ExpertApplicationWizard: ({
    draft,
    referenceData,
    user,
  }: {
    draft: ApplicationWithRelations | null;
    referenceData: ReferenceData;
    user: { id: string } | null;
  }): React.JSX.Element => (
    <div data-testid="wizard">
      <span data-testid="user">{user ? JSON.stringify(user) : 'null'}</span>
      <span data-testid="draft">{draft ? 'has-draft' : 'null'}</span>
      {/* The WHOLE prop, serialised — this is what the RSC flight payload carries. */}
      <span data-testid="draft-json">{draft === null ? 'null' : JSON.stringify(draft)}</span>
      <span data-testid="vertical">{referenceData.vertical.id}</span>
    </div>
  ),
}));

// Stub the declined panel the same way — this suite pins what the PAGE computes and passes
// (the date string, the boolean), never a full application shape (BAL-557).
vi.mock('./_components/declined-application-panel', () => ({
  DeclinedApplicationPanel: ({
    reapplyAvailableOn,
    canStartNow,
  }: {
    reapplyAvailableOn: string | null;
    canStartNow: boolean;
  }): React.JSX.Element => (
    <div data-testid="declined-panel">
      <span data-testid="reapply-available-on">{reapplyAvailableOn ?? 'null'}</span>
      <span data-testid="can-start-now">{String(canStartNow)}</span>
    </div>
  ),
}));

import ExpertApplyPage from './page';

function buildUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-secret-id',
    email: 'dana@northwind.example',
    firstName: 'Dana',
    lastName: 'Okafor',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: 'company-secret-id',
    companyName: 'Northwind Industrial',
    companyRole: 'owner',
    ...overrides,
  };
}

const referenceData: ReferenceData = {
  productsByCategory: [],
  supportTypes: [],
  certificationsByCategory: [],
  languages: [],
  industries: [],
  vertical: { id: 'vertical-1' } as ReferenceData['vertical'],
};

function buildDraft(overrides: Record<string, unknown> = {}): ApplicationWithRelations {
  return {
    profile: {
      id: 'profile-1',
      userId: 'user-secret-id',
      applicationStatus: 'draft',
      ...overrides,
    },
    competencies: [],
    certifications: [],
    languages: [],
    industries: [],
    workHistory: [],
  } as unknown as ApplicationWithRelations;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadReferenceData.mockResolvedValue(referenceData);
  mockPlatformSettingsGet.mockResolvedValue({ value: 60, source: 'stored' });
});

describe('ExpertApplyPage — anonymous', () => {
  it('renders the wizard with draft=null, user=null, and never calls loadDraftAction', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    render(await ExpertApplyPage());

    expect(screen.getByTestId('wizard')).toBeInTheDocument();
    expect(screen.getByTestId('user').textContent).toBe('null');
    expect(screen.getByTestId('draft').textContent).toBe('null');
    expect(mockLoadDraftAction).not.toHaveBeenCalled();
    expect(mockLoadReferenceData).toHaveBeenCalledTimes(1);
  });

  it('passes only the taxonomy — the rendered output contains no session-shaped value', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const { container } = render(await ExpertApplyPage());

    // Fixture id/email/companyId strings that would appear if a session ever leaked.
    expect(container.innerHTML).not.toContain('user-secret-id');
    expect(container.innerHTML).not.toContain('dana@northwind.example');
    expect(container.innerHTML).not.toContain('company-secret-id');
  });
});

describe('ExpertApplyPage — authenticated', () => {
  it('redirects a not-onboarded user to /onboarding before touching the draft', async () => {
    mockGetCurrentUser.mockResolvedValue(buildUser({ onboardingCompleted: false }));
    await expect(ExpertApplyPage()).rejects.toThrow(/REDIRECT:/);
    expect(mockRedirect).toHaveBeenCalledWith('/onboarding');
    expect(mockLoadDraftAction).not.toHaveBeenCalled();
  });

  it('redirects a submitted application to /expert/apply/success', async () => {
    mockGetCurrentUser.mockResolvedValue(buildUser());
    mockLoadDraftAction.mockResolvedValue({
      draft: buildDraft({ applicationStatus: 'submitted' }),
      referenceData,
    });
    await expect(ExpertApplyPage()).rejects.toThrow(/REDIRECT:/);
    expect(mockRedirect).toHaveBeenCalledWith('/expert/apply/success');
  });

  it('redirects an under_review application to /expert/apply/success', async () => {
    mockGetCurrentUser.mockResolvedValue(buildUser());
    mockLoadDraftAction.mockResolvedValue({
      draft: buildDraft({ applicationStatus: 'under_review' }),
      referenceData,
    });
    await expect(ExpertApplyPage()).rejects.toThrow(/REDIRECT:/);
    expect(mockRedirect).toHaveBeenCalledWith('/expert/apply/success');
  });

  it('redirects an approved application to /dashboard', async () => {
    mockGetCurrentUser.mockResolvedValue(buildUser());
    mockLoadDraftAction.mockResolvedValue({
      draft: buildDraft({ applicationStatus: 'approved' }),
      referenceData,
    });
    await expect(ExpertApplyPage()).rejects.toThrow(/REDIRECT:/);
    expect(mockRedirect).toHaveBeenCalledWith('/dashboard');
  });

  it('renders the wizard with the resolved user and null draft when none exists', async () => {
    mockGetCurrentUser.mockResolvedValue(buildUser());
    mockLoadDraftAction.mockResolvedValue({ draft: null, referenceData });

    render(await ExpertApplyPage());

    expect(screen.getByTestId('draft').textContent).toBe('null');
    // FIX round (smaller item) — page.tsx no longer passes `email` at all (dead
    // payload; no `_components/` consumer read it). `{ id }` only.
    expect(screen.getByTestId('user').textContent).toBe(JSON.stringify({ id: 'user-secret-id' }));
  });

  it('renders the wizard with a draft in progress', async () => {
    mockGetCurrentUser.mockResolvedValue(buildUser());
    mockLoadDraftAction.mockResolvedValue({ draft: buildDraft(), referenceData });

    render(await ExpertApplyPage());

    expect(screen.getByTestId('draft').textContent).toBe('has-draft');
  });

  /**
   * BAL-557 — `'rejected'` RENDERS THE DECLINED PANEL, NOT THE WIZARD, AND CARRIES NO
   * DECISION METADATA INTO THE CLIENT PAYLOAD AT ALL.
   *
   * Before BAL-557, nothing redirected a declined applicant away, so `'rejected'` fell through to
   * the wizard (prefilled, with the decision columns stripped as defence in depth) and every
   * write refused. That fall-through is gone: the wizard never renders for `'rejected'`, so there
   * is nothing left to strip — the panel receives only a date string and a boolean.
   *
   * MUTATION: drop the `rejected` branch and fall through to the wizard → red (no panel, and the
   * raw `draft` — including `declineReason`/`decidedByUserId` — reaches the wizard stub).
   */
  it('renders the declined panel — not the wizard — for a rejected application, with no decision metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-10T00:00:00.000Z')); // 8 days after decidedAt — cooldown still active
    try {
      mockGetCurrentUser.mockResolvedValue(buildUser());
      mockLoadDraftAction.mockResolvedValue({
        draft: buildDraft({
          applicationStatus: 'rejected',
          declineReason: 'credentials_unverified',
          decidedAt: new Date('2026-02-02T00:00:00.000Z'),
          decidedByUserId: 'staffer-secret-id',
        }),
        referenceData,
      });

      const { container } = render(await ExpertApplyPage());

      expect(mockRedirect).not.toHaveBeenCalled();
      expect(screen.getByTestId('declined-panel')).toBeInTheDocument();
      expect(screen.queryByTestId('wizard')).toBeNull();

      // Only a pre-formatted date string and a boolean cross into the client payload.
      expect(container.innerHTML).not.toContain('credentials_unverified');
      expect(container.innerHTML).not.toContain('staffer-secret-id');
      expect(screen.getByTestId('reapply-available-on').textContent).toBe('3 Apr 2026'); // 2026-02-02 + 60d
      expect(screen.getByTestId('can-start-now').textContent).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the declined panel as ready once the cooldown has passed', async () => {
    mockGetCurrentUser.mockResolvedValue(buildUser());
    mockLoadDraftAction.mockResolvedValue({
      draft: buildDraft({
        applicationStatus: 'rejected',
        decidedAt: new Date('2020-01-01T00:00:00.000Z'),
      }),
      referenceData,
    });

    render(await ExpertApplyPage());

    expect(screen.getByTestId('can-start-now').textContent).toBe('true');
  });

  it('reads the live reapply-cooldown platform setting, never a hard-coded value', async () => {
    mockGetCurrentUser.mockResolvedValue(buildUser());
    mockLoadDraftAction.mockResolvedValue({
      draft: buildDraft({
        applicationStatus: 'rejected',
        decidedAt: new Date('2026-02-02T00:00:00.000Z'),
      }),
      referenceData,
    });

    render(await ExpertApplyPage());

    expect(mockPlatformSettingsGet).toHaveBeenCalledWith('expert_reapply_cooldown_days');
  });
});
