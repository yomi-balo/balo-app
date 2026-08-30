import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { ApplyHeaderActions } from './apply-header-actions';
import type { MarketingViewer } from '@/components/marketing/marketing-viewer';

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
});

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
