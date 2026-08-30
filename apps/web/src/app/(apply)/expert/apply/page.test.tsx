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

vi.mock('next/navigation', () => ({ redirect: mockRedirect }));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('@/lib/expert-apply/reference-data', () => ({
  loadReferenceData: mockLoadReferenceData,
}));
vi.mock('./_actions/load-draft', () => ({ loadDraftAction: mockLoadDraftAction }));

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
      <span data-testid="vertical">{referenceData.vertical.id}</span>
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
});
