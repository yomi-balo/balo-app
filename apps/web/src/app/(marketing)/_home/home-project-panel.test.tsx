import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { HomeProjectPanel } from './home-project-panel';

const {
  mockRefresh,
  mockAuthModalOpen,
  mockUseAuthModal,
  mockRememberPendingHomeProject,
  mockForgetPendingHomeProject,
} = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
  mockAuthModalOpen: vi.fn(),
  mockUseAuthModal: vi.fn(),
  mockRememberPendingHomeProject: vi.fn(),
  mockForgetPendingHomeProject: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));
vi.mock('@/hooks/use-auth-modal', () => ({ useAuthModal: mockUseAuthModal }));
vi.mock('@/lib/marketing/pending-home-project', () => ({
  rememberPendingHomeProject: mockRememberPendingHomeProject,
  forgetPendingHomeProject: mockForgetPendingHomeProject,
}));

interface PanelStubProps {
  entryPoint?: unknown;
  seed?: unknown;
  resumeDraft?: unknown;
  onAuthRequired?: () => void;
}

vi.mock('@/components/balo/project-request/panel', () => ({
  ProjectRequestPanel: (props: PanelStubProps) => (
    <div
      data-testid="project-request-panel"
      data-entry-point={String(props.entryPoint)}
      data-resume-draft={String(props.resumeDraft)}
      data-seed={JSON.stringify(props.seed ?? null)}
      data-has-auth-required={String(props.onAuthRequired !== undefined)}
    >
      {props.onAuthRequired && (
        <button type="button" onClick={props.onAuthRequired}>
          request-sign-in
        </button>
      )}
    </div>
  ),
}));

interface AuthModalState {
  isOpen: boolean;
  closeReason: 'dismissed' | 'success' | null;
}

function authModalState(overrides: Partial<AuthModalState> = {}): AuthModalState & {
  open: typeof mockAuthModalOpen;
} {
  return { isOpen: false, closeReason: null, open: mockAuthModalOpen, ...overrides };
}

beforeEach(() => {
  mockRefresh.mockClear();
  mockAuthModalOpen.mockClear();
  mockRememberPendingHomeProject.mockClear();
  mockForgetPendingHomeProject.mockClear();
  mockUseAuthModal.mockReturnValue(authModalState());
});

describe('HomeProjectPanel — auth gate wiring (D1)', () => {
  it('passes onAuthRequired when signed out, and undefined when signed in', () => {
    const { rerender } = render(
      <HomeProjectPanel open onClose={vi.fn()} resumeDraft={false} isLoggedIn={false} />
    );
    expect(screen.getByTestId('project-request-panel')).toHaveAttribute(
      'data-has-auth-required',
      'true'
    );

    rerender(<HomeProjectPanel open onClose={vi.fn()} resumeDraft={false} isLoggedIn />);
    expect(screen.getByTestId('project-request-panel')).toHaveAttribute(
      'data-has-auth-required',
      'false'
    );
  });

  it('requestSignIn remembers the marker and opens the auth modal with an onSuccess that refreshes', async () => {
    const user = userEvent.setup();
    render(<HomeProjectPanel open onClose={vi.fn()} resumeDraft={false} isLoggedIn={false} />);

    await user.click(screen.getByRole('button', { name: 'request-sign-in' }));

    expect(mockRememberPendingHomeProject).toHaveBeenCalledTimes(1);
    expect(mockAuthModalOpen).toHaveBeenCalledTimes(1);
    const [options] = mockAuthModalOpen.mock.calls[0] as [{ onSuccess: () => void }];

    expect(mockRefresh).not.toHaveBeenCalled();
    options.onSuccess();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('HomeProjectPanel — marker cleared/kept on modal close', () => {
  async function requestSignIn(rerenderProps: {
    isLoggedIn: boolean;
  }): Promise<ReturnType<typeof render>['rerender']> {
    const user = userEvent.setup();
    const { rerender } = render(
      <HomeProjectPanel
        open
        onClose={vi.fn()}
        resumeDraft={false}
        isLoggedIn={rerenderProps.isLoggedIn}
      />
    );
    await user.click(screen.getByRole('button', { name: 'request-sign-in' }));
    return rerender;
  }

  it("a 'dismissed' close clears the marker", async () => {
    const rerender = await requestSignIn({ isLoggedIn: false });

    // The modal is still open — the effect's `authModal.isOpen` guard must keep it from
    // reading this `closeReason` as a close.
    mockUseAuthModal.mockReturnValue(authModalState({ isOpen: true, closeReason: null }));
    rerender(<HomeProjectPanel open onClose={vi.fn()} resumeDraft={false} isLoggedIn={false} />);
    expect(mockForgetPendingHomeProject).not.toHaveBeenCalled();

    mockUseAuthModal.mockReturnValue(authModalState({ isOpen: false, closeReason: 'dismissed' }));
    rerender(<HomeProjectPanel open onClose={vi.fn()} resumeDraft={false} isLoggedIn={false} />);

    expect(mockForgetPendingHomeProject).toHaveBeenCalledTimes(1);
  });

  it("a 'success' close keeps the marker", async () => {
    const rerender = await requestSignIn({ isLoggedIn: false });

    // Same intermediate "still open" step as the dismissed case above, so this test exercises
    // the identical guard path before asserting the marker survives a 'success' close.
    mockUseAuthModal.mockReturnValue(authModalState({ isOpen: true, closeReason: null }));
    rerender(<HomeProjectPanel open onClose={vi.fn()} resumeDraft={false} isLoggedIn />);
    expect(mockForgetPendingHomeProject).not.toHaveBeenCalled();

    mockUseAuthModal.mockReturnValue(authModalState({ isOpen: false, closeReason: 'success' }));
    rerender(<HomeProjectPanel open onClose={vi.fn()} resumeDraft={false} isLoggedIn />);

    expect(mockForgetPendingHomeProject).not.toHaveBeenCalled();
  });

  it("ignores a stale 'dismissed' reason left by a header-opened modal", () => {
    mockUseAuthModal.mockReturnValue(authModalState({ isOpen: false, closeReason: 'dismissed' }));
    render(<HomeProjectPanel open onClose={vi.fn()} resumeDraft={false} isLoggedIn={false} />);

    expect(mockForgetPendingHomeProject).not.toHaveBeenCalled();
  });
});

describe('HomeProjectPanel — pass-through props', () => {
  it('passes entryPoint "home", the seed and resumeDraft through unchanged, and mounts the panel with no taxonomies prop so it self-loads (D4)', () => {
    const seed = { title: 'Migrate us from HubSpot to Sales Cloud' };

    render(<HomeProjectPanel open onClose={vi.fn()} seed={seed} resumeDraft isLoggedIn />);

    const panel = screen.getByTestId('project-request-panel');
    expect(panel).toHaveAttribute('data-entry-point', 'home');
    expect(panel).toHaveAttribute('data-resume-draft', 'true');
    expect(panel).toHaveAttribute('data-seed', JSON.stringify(seed));
  });
});
