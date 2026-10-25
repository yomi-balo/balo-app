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
  title: 'Priya @ CloudPeak Consulting says the project is ready',
  body: 'Have a look through the milestones below, then accept the project or request changes.',
  countdown: { autoOnDate: '11 Jul 2026', daysRemaining: 5, autoInLabel: 'Auto-accepts in 5 days' },
  clientDecision: {
    acceptModalBody: 'Accepting confirms the delivery as agreed.',
    requestChangesIntro: 'The project goes back to active with your note.',
    requestChangesFieldHint: 'Be specific.',
    milestoneOptions: [{ id: 'm-1', title: 'Build' }],
    milestoneHelper: 'Milestones you pick go back to CloudPeak with your feedback.',
  },
  lastRequest: null,
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
      screen.getByText('Priya @ CloudPeak Consulting says the project is ready')
    ).toBeInTheDocument();
    expect(screen.getByText(/Have a look through the milestones below/)).toBeInTheDocument();
    expect(screen.getByText('Auto-accepts in 5 days')).toBeInTheDocument();
  });

  it('quotes the previous change request under the body when there was one', () => {
    render(
      <ReviewBanner
        {...baseProps}
        lens="client"
        banner={{
          ...banner,
          lastRequest: { heading: 'Your last request · 6 Jul', note: 'Fix the totals.' },
        }}
      />
    );
    expect(screen.getByText('Your last request · 6 Jul')).toBeInTheDocument();
    expect(screen.getByText('Fix the totals.')).toBeInTheDocument();
  });

  it('renders no quote block on a first submission', () => {
    render(<ReviewBanner {...baseProps} lens="client" />);
    expect(screen.queryByText(/Your last request/)).not.toBeInTheDocument();
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
