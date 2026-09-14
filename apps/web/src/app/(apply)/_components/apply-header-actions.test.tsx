import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { ApplyHeaderActions } from './apply-header-actions';
import type { MarketingViewer } from '@/components/marketing/marketing-viewer';
import {
  ANON_DRAFT_KEY,
  writeAnonymousDraft,
  readAnonymousDraft,
} from '@/lib/expert-apply/anonymous-draft';

const routerRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }),
}));

const authModalOpen = vi.fn();
vi.mock('@/hooks/use-auth-modal', () => ({
  useAuthModal: () => ({ open: authModalOpen }),
}));

function makeViewer(overrides: Partial<MarketingViewer> = {}): MarketingViewer {
  return { displayName: 'Dana Okafor', initials: 'DO', avatarUrl: null, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.sessionStorage.clear();
});

function seedAnonymousEnvelope(): void {
  writeAnonymousDraft({
    v: 1,
    savedAt: new Date().toISOString(),
    currentStep: 3,
    maxReachedStep: 4,
    steps: { profile: { yearStartedSalesforce: 2015 } },
  });
}

describe('ApplyHeaderActions — anonymous (viewer null)', () => {
  it('renders a "Log in" control, no UserMenu, no "Log out" item, no User/U fallback', () => {
    render(<ApplyHeaderActions viewer={null} />);

    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument();
    expect(screen.queryByText('Log out')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/user menu for user/i)).not.toBeInTheDocument();
  });

  it('opens the unified auth modal (no defaultStep) and refreshes on success', async () => {
    const user = userEvent.setup();
    render(<ApplyHeaderActions viewer={null} />);

    await user.click(screen.getByRole('button', { name: 'Log in' }));

    expect(authModalOpen).toHaveBeenCalledTimes(1);
    const [openArgs] = authModalOpen.mock.calls[0] as [Record<string, unknown>];
    expect(openArgs).not.toHaveProperty('defaultStep');

    const onSuccess = openArgs.onSuccess as () => void;
    onSuccess();
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('ApplyHeaderActions — signed in (viewer present)', () => {
  it('renders the real UserMenu with the viewer name and initials', () => {
    render(<ApplyHeaderActions viewer={makeViewer()} />);

    expect(screen.getByRole('button', { name: /user menu for dana okafor/i })).toBeInTheDocument();
    expect(screen.getByText('DO')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log in' })).not.toBeInTheDocument();
  });
});

describe('BAL-562 — the header auth gate stamps the anonymous draft', () => {
  /**
   * THE REGRESSION PROBE. This control is the only auth affordance on six of the
   * wizard's seven steps. Remove `stampAuthGate()` from `handleLogIn` and the envelope
   * reaching the post-auth flush carries no gate crossing, so the freshness guard
   * discards the visitor's whole in-progress application — silently, with no toast.
   */
  it('stamps a pending envelope BEFORE opening the modal', async () => {
    seedAnonymousEnvelope();
    const stampedAtOpen: (string | undefined)[] = [];
    authModalOpen.mockImplementation(() => {
      stampedAtOpen.push(readAnonymousDraft()?.authGateAt);
    });

    const user = userEvent.setup();
    render(<ApplyHeaderActions viewer={null} />);
    await user.click(screen.getByRole('button', { name: 'Log in' }));

    // Ordering matters: by the time the modal is open the stamp must already be
    // durable, because the OAuth arm navigates the page away immediately.
    expect(stampedAtOpen).toHaveLength(1);
    expect(stampedAtOpen[0]).toEqual(expect.any(String));
  });

  it('leaves the envelope content untouched — it stamps, it does not rewrite', async () => {
    seedAnonymousEnvelope();

    const user = userEvent.setup();
    render(<ApplyHeaderActions viewer={null} />);
    await user.click(screen.getByRole('button', { name: 'Log in' }));

    const stored = readAnonymousDraft();
    expect(stored?.steps.profile).toEqual({ yearStartedSalesforce: 2015 });
    expect(stored?.currentStep).toBe(3);
    expect(stored?.maxReachedStep).toBe(4);
  });

  it('writes nothing when there is no envelope — every (apply) route except the wizard', async () => {
    const user = userEvent.setup();
    render(<ApplyHeaderActions viewer={null} />);
    await user.click(screen.getByRole('button', { name: 'Log in' }));

    expect(globalThis.sessionStorage.getItem(ANON_DRAFT_KEY)).toBeNull();
    expect(authModalOpen).toHaveBeenCalledTimes(1);
  });

  /**
   * Rewritten — it used to render a SIGNED-IN viewer and assert no stamp, which passes
   * under every possible reversion of the fix because that variant has no control to
   * click. This version renders the ANONYMOUS variant and still clicks nothing, so it
   * genuinely fails if `stampAuthGate()` ever migrates out of the click handler into
   * the component body: stamping is an act of intent and must cost a deliberate click,
   * never a render.
   */
  it('does not stamp on render — only a deliberate click may claim a draft', () => {
    seedAnonymousEnvelope();

    render(<ApplyHeaderActions viewer={null} />);

    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument();
    expect(readAnonymousDraft()?.authGateAt).toBeUndefined();
  });

  it('refuses to stamp an abandoned draft, so a second person at this tab cannot claim it', async () => {
    // Older than AUTH_GATE_FLUSH_WINDOW_MS — nobody has touched it in a long while.
    writeAnonymousDraft({
      v: 1,
      savedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
      currentStep: 3,
      maxReachedStep: 4,
      steps: { profile: { yearStartedSalesforce: 2015 } },
    });

    const user = userEvent.setup();
    render(<ApplyHeaderActions viewer={null} />);
    await user.click(screen.getByRole('button', { name: 'Log in' }));

    // The modal still opens — the person wanting their own account is not blocked...
    expect(authModalOpen).toHaveBeenCalledTimes(1);
    // ...but the draft is not claimable by them.
    expect(readAnonymousDraft()?.authGateAt).toBeUndefined();
  });
});
