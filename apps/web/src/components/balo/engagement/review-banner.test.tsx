import { describe, it, expect, vi } from 'vitest';

import { render, screen } from '@/test/utils';
import type { ReviewBannerView } from '@/lib/engagement/engagement-view';

// ReviewBanner renders the client island ReviewBannerActions (hook + Server Actions).
// Mock the router/toast and the action modules so this test doesn't pull @balo/db.
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/withdraw-completion-request', () => ({
  withdrawCompletionRequestAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/accept-project', () => ({
  acceptProjectAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/request-changes', () => ({
  requestProjectChangesAction: vi.fn(),
}));

import { ReviewBanner } from './review-banner';

const banner: ReviewBannerView = {
  title: 'Priya @ CloudPeak Consulting has marked the project complete',
  body: 'Review the delivery plan below, then accept the project or request changes.',
  countdown: { autoOnDate: '11 Jul 2026', daysRemaining: 5, autoInLabel: 'Auto-accepts in 5 days' },
  clientDecision: {
    acceptModalBody: 'Accepting confirms the delivery as agreed.',
    requestChangesIntro: 'The project goes back to active with your note.',
    requestChangesFieldHint: 'Be specific.',
  },
};

const baseProps = {
  banner,
  engagementId: 'eng-1',
  clientCompanyName: 'Northwind Industrial',
  initialAction: null,
} as const;

describe('ReviewBanner', () => {
  it('renders the title, body, and informational countdown pill', () => {
    render(<ReviewBanner {...baseProps} lens="client" />);
    expect(
      screen.getByText('Priya @ CloudPeak Consulting has marked the project complete')
    ).toBeInTheDocument();
    expect(screen.getByText(/Review the delivery plan below/)).toBeInTheDocument();
    expect(screen.getByText('Auto-accepts in 5 days')).toBeInTheDocument();
  });

  it('omits the countdown pill when countdown is null', () => {
    render(<ReviewBanner {...baseProps} lens="client" banner={{ ...banner, countdown: null }} />);
    expect(screen.queryByText(/Auto-accepts in/)).not.toBeInTheDocument();
  });

  it('renders the expert "Withdraw request" action for the expert lens', () => {
    render(<ReviewBanner {...baseProps} lens="expert" />);
    expect(screen.getByRole('button', { name: /Withdraw request/i })).toBeInTheDocument();
  });

  it('renders the client accept / request-changes decision actions', () => {
    render(<ReviewBanner {...baseProps} lens="client" />);
    expect(screen.getByRole('button', { name: /Accept project/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Request changes/i })).toBeInTheDocument();
  });

  it('renders NO action buttons for the admin lens', () => {
    render(<ReviewBanner {...baseProps} lens="admin" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
