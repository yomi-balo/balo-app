import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axe } from 'jest-axe';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { track, REVIEW_EVENTS } from '@/lib/analytics';
import type { EndOfCallRatingView } from '@/lib/meetings/end-of-call-view-types';
import { EngagementRatingCard } from './engagement-rating-card';

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000005';

vi.mock('server-only', () => ({}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// `RatingBlock` swaps its own content via `StateSwap` (`motion/react`) — stubbed the same way
// every other consumer test stubs it. The default passthrough mode is sufficient here; this
// file does not exercise focus handoff across the swap.
vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

const mockSubmit = vi.fn();
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/submit-engagement-review', () => ({
  submitEngagementReviewAction: (...a: unknown[]) => mockSubmit(...a),
}));

const trackMock = vi.mocked(track);

const NONE: EndOfCallRatingView = {
  engagementId: ENGAGEMENT_ID,
  state: { kind: 'none' },
  existingBody: null,
};
const RATED_OK: EndOfCallRatingView = {
  engagementId: ENGAGEMENT_ID,
  state: { kind: 'rated_ok', rating: 5 },
  existingBody: null,
};
const RATED_LOW: EndOfCallRatingView = {
  engagementId: ENGAGEMENT_ID,
  state: { kind: 'rated_low', rating: 3 },
  existingBody: null,
};

describe('EngagementRatingCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['none', NONE],
    ['rated_ok', RATED_OK],
    ['rated_low', RATED_LOW],
  ] as const)('fires review_prompt_viewed once per mount — %s', (_label, rating) => {
    render(
      <EngagementRatingCard
        rating={rating}
        counterpartyName="Amara"
        engagementKind="project"
        surface="project_workspace"
        frame="section"
      />
    );

    expect(trackMock).toHaveBeenCalledWith(REVIEW_EVENTS.PROMPT_VIEWED, {
      surface: 'project_workspace',
      state: rating.state.kind,
      engagement_kind: 'project',
    });
    expect(trackMock).toHaveBeenCalledTimes(1);
  });

  it('carries EXACTLY surface, state and engagement_kind — no name, no body', () => {
    render(
      <EngagementRatingCard
        rating={RATED_LOW}
        counterpartyName="Amara"
        engagementKind="case"
        surface="case_surface"
        frame="rail"
      />
    );

    const payload = trackMock.mock.calls.at(-1)?.[1];
    expect(Object.keys(payload as object).sort((a, b) => a.localeCompare(b))).toEqual([
      'engagement_kind',
      'state',
      'surface',
    ]);
  });

  it('does not re-fire the event on a re-render with new props', () => {
    const { rerender } = render(
      <EngagementRatingCard
        rating={NONE}
        counterpartyName="Amara"
        engagementKind="project"
        surface="project_workspace"
        frame="section"
      />
    );
    expect(trackMock).toHaveBeenCalledTimes(1);

    rerender(
      <EngagementRatingCard
        rating={RATED_OK}
        counterpartyName="Dana"
        engagementKind="case"
        surface="case_surface"
        frame="rail"
      />
    );
    expect(trackMock).toHaveBeenCalledTimes(1);
  });

  it('calls the write action with the given surface on a star submit', async () => {
    mockSubmit.mockResolvedValue({ success: true, created: true });
    const user = userEvent.setup();
    render(
      <EngagementRatingCard
        rating={NONE}
        counterpartyName="Amara"
        engagementKind="case"
        surface="recap"
        frame="none"
      />
    );

    await user.click(screen.getByRole('radio', { name: '5 out of 5 — Outstanding' }));
    await user.click(screen.getByRole('button', { name: 'Save review' }));

    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ engagementId: ENGAGEMENT_ID, surface: 'recap' })
    );
  });

  it('asks with the card heading, never the end-of-call default', () => {
    render(
      <EngagementRatingCard
        rating={NONE}
        counterpartyName="Amara"
        engagementKind="project"
        surface="project_workspace"
        frame="section"
      />
    );
    expect(screen.getByText('How was working with Amara?')).toBeInTheDocument();
    expect(screen.queryByText(/consultation with Amara/)).not.toBeInTheDocument();
  });

  it('renders the question as an h3, never a second h2 alongside the frame heading', () => {
    render(
      <EngagementRatingCard
        rating={NONE}
        counterpartyName="Amara"
        engagementKind="project"
        surface="project_workspace"
        frame="section"
      />
    );
    expect(
      screen.getByRole('heading', { level: 3, name: 'How was working with Amara?' })
    ).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
  });

  it('has no accessibility violations, framed or inline', async () => {
    const { container, unmount } = render(
      <EngagementRatingCard
        rating={NONE}
        counterpartyName="Amara"
        engagementKind="project"
        surface="project_workspace"
        frame="section"
      />
    );
    expect(await axe(container)).toHaveNoViolations();
    unmount();

    const inline = render(
      <EngagementRatingCard
        rating={RATED_LOW}
        counterpartyName="Amara"
        engagementKind="case"
        surface="recap"
        frame="none"
      />
    );
    expect(await axe(inline.container)).toHaveNoViolations();
  });
});

describe('EngagementRatingCard — frame variants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('`section` renders the project-workspace rail card', () => {
    const { container } = render(
      <EngagementRatingCard
        rating={RATED_OK}
        counterpartyName="Amara"
        engagementKind="project"
        surface="project_workspace"
        frame="section"
      />
    );
    const section = container.querySelector('section');
    expect(section).not.toBeNull();
    expect(section?.className).toContain('rounded-2xl');
    expect(section?.className).toContain('p-6');
    expect(screen.getByRole('heading', { name: 'Your rating' })).toBeInTheDocument();
  });

  it('`rail` renders the case-rail sibling style', () => {
    const { container } = render(
      <EngagementRatingCard
        rating={RATED_OK}
        counterpartyName="Amara"
        engagementKind="case"
        surface="case_surface"
        frame="rail"
      />
    );
    const section = container.querySelector('section');
    expect(section).not.toBeNull();
    expect(section?.className).toContain('rounded-xl');
    expect(section?.className).toContain('px-5');
    expect(section?.className).toContain('py-4');
    expect(screen.getByRole('heading', { name: 'Your rating' })).toBeInTheDocument();
  });

  it('`none` renders no frame at all', () => {
    const { container } = render(
      <EngagementRatingCard
        rating={RATED_OK}
        counterpartyName="Amara"
        engagementKind="case"
        surface="recap"
        frame="none"
      />
    );
    expect(container.querySelector('section')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Your rating' })).not.toBeInTheDocument();
    // The rating itself still renders — only the frame is absent.
    expect(screen.getByText('Your rating for Amara')).toBeInTheDocument();
  });
});
