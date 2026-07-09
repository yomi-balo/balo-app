import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';

import type { CompletionCardView } from '@/lib/engagement/engagement-view';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/request-completion', () => ({
  requestCompletionAction: vi.fn(),
}));

import { ExpertCompletionCard } from './expert-completion-card';
import { requestCompletionAction } from '@/app/(dashboard)/engagements/[id]/_actions/request-completion';
import { track, ENGAGEMENT_EVENTS } from '@/lib/analytics';
import { toast } from 'sonner';

const requestMock = vi.mocked(requestCompletionAction);

function card(overrides: Partial<CompletionCardView> = {}): CompletionCardView {
  return {
    hasMilestones: true,
    milestonesRemaining: 0,
    milestonesTotal: 2,
    canRequest: true,
    bodyCopy: 'Every milestone is delivered.',
    modalBody: 'All 2 milestones are delivered. Northwind reviews the whole project…',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requestMock.mockResolvedValue({ success: true });
});

describe('ExpertCompletionCard', () => {
  it('renders the pre-derived body copy and the enabled CTA when canRequest', () => {
    render(
      <ExpertCompletionCard engagementId="eng-1" card={card()} clientCompanyName="Northwind" />
    );
    expect(screen.getByText('Finish the project')).toBeInTheDocument();
    expect(screen.getByText('Every milestone is delivered.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Mark project complete/i })).toBeEnabled();
  });

  it('disables the CTA when blocked (milestones remaining)', () => {
    render(
      <ExpertCompletionCard
        engagementId="eng-1"
        card={card({
          canRequest: false,
          milestonesRemaining: 1,
          bodyCopy: '1 of 2 milestone still to complete before the project can be sent…',
        })}
        clientCompanyName="Northwind"
      />
    );
    expect(screen.getByRole('button', { name: /Mark project complete/i })).toBeDisabled();
  });

  it('fires the blocked-view analytics ONCE on mount when the card is disabled', () => {
    render(
      <ExpertCompletionCard
        engagementId="eng-1"
        card={card({ canRequest: false, milestonesRemaining: 2 })}
        clientCompanyName="Northwind"
      />
    );
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(ENGAGEMENT_EVENTS.COMPLETION_BLOCKED_VIEW, {
      engagement_id: 'eng-1',
      milestones_remaining: 2,
    });
  });

  it('does NOT fire the blocked-view analytics when the card is enabled', () => {
    render(
      <ExpertCompletionCard engagementId="eng-1" card={card()} clientCompanyName="Northwind" />
    );
    expect(track).not.toHaveBeenCalled();
  });

  it('opens the modal and calls the action + toasts on confirm', async () => {
    const user = userEvent.setup();
    render(
      <ExpertCompletionCard engagementId="eng-1" card={card()} clientCompanyName="Northwind" />
    );

    await user.click(screen.getByRole('button', { name: /Mark project complete/i }));
    const confirm = await screen.findByRole('button', { name: /Send for Northwind's review/i });
    await user.click(confirm);

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith({ engagementId: 'eng-1' });
    });
    expect(toast.success).toHaveBeenCalledWith('Project sent for review');
  });
});
