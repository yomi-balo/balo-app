import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CALL_NOW_EVENTS } from '@balo/analytics/events';
import { track } from '@/lib/analytics';
import { axe } from '@/test/axe';
import { CALL_NOW_COPY } from '@/lib/call-now/call-now-copy';

vi.mock('@/lib/call-now/use-call-now-surface', () => ({
  useCallNowSurface: () => 'mobile',
}));

import { CallNowEndedCard, type CallNowEndedCardProps } from './call-now-ended-card';

const ENGAGEMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ATTEMPT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const BASE: CallNowEndedCardProps = {
  outcome: 'unanswered',
  calleeLabel: 'Dana',
  copyArm: 'client',
  bookInPage: true,
  engagementId: ENGAGEMENT_ID,
  attemptId: ATTEMPT_ID,
};

beforeEach(() => {
  vi.clearAllMocks();
});

function renderCard(overrides: Partial<CallNowEndedCardProps> = {}): HTMLElement {
  return render(<CallNowEndedCard {...BASE} {...overrides} />).container;
}

describe('CallNowEndedCard', () => {
  it('unanswered: "No answer from {name}" and the client’s nothing-charged line', () => {
    renderCard();

    expect(
      screen.getByRole('heading', { name: CALL_NOW_COPY.noAnswerTitle('Dana') })
    ).toBeVisible();
    expect(screen.getByText(CALL_NOW_COPY.noAnswerClient('Dana'))).toBeVisible();
  });

  it('declined: "{name} can’t talk right now"', () => {
    renderCard({ outcome: 'declined' });

    expect(
      screen.getByRole('heading', { name: CALL_NOW_COPY.declinedTitle('Dana') })
    ).toBeVisible();
  });

  it('⚠ declined says nothing about being seen — no missed-call item follows "Not now"', () => {
    const { container } = render(
      <CallNowEndedCard {...BASE} outcome="declined" calleeLabel="Dana" />
    );
    expect(screen.getByText(CALL_NOW_COPY.declinedClient)).toBeVisible();
    expect(container.textContent ?? '').not.toMatch(/will see that you called/);

    const expert = render(
      <CallNowEndedCard {...BASE} outcome="declined" copyArm="expert" bookInPage={false} />
    );
    expect(screen.getByText(CALL_NOW_COPY.declinedExpert)).toBeVisible();
    expect(expert.container.textContent ?? '').not.toMatch(/will see that you called/);
  });

  it('unanswered still tells the caller the other side will see the call', () => {
    const container = renderCard();

    expect(container.textContent ?? '').toMatch(/will see that you called/);
  });

  it('expert arm: names the company and says nothing was counted', () => {
    renderCard({ copyArm: 'expert', calleeLabel: 'Northwind', bookInPage: false });

    expect(screen.getByText(CALL_NOW_COPY.noAnswerExpert('Northwind'))).toBeVisible();
    expect(screen.queryByText(CALL_NOW_COPY.noAnswerClient('Northwind'))).toBeNull();
  });

  it('client with a bookable expert: Book a time (filled) and Back to the case', () => {
    renderCard();

    expect(screen.getByRole('link', { name: CALL_NOW_COPY.bookInstead })).toHaveAttribute(
      'href',
      `/cases/${ENGAGEMENT_ID}?book=1`
    );
    expect(screen.getByRole('link', { name: CALL_NOW_COPY.backToCase })).toHaveAttribute(
      'href',
      `/cases/${ENGAGEMENT_ID}`
    );
  });

  it('⚠ Book a time tracks the book-instead event as no_answer, for declined and unanswered alike', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<CallNowEndedCard {...BASE} />);
    await user.click(screen.getByRole('link', { name: CALL_NOW_COPY.bookInstead }));
    expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.BOOK_INSTEAD_CLICKED, {
      attempt_id: ATTEMPT_ID,
      lens: 'client',
      from: 'no_answer',
      surface: 'mobile',
    });
    unmount();

    render(<CallNowEndedCard {...BASE} outcome="declined" />);
    await user.click(screen.getByRole('link', { name: CALL_NOW_COPY.bookInstead }));
    expect(track).toHaveBeenCalledTimes(2);
  });

  it('a ring with no persisted attempt id tracks nothing on Book a time', async () => {
    render(<CallNowEndedCard {...BASE} attemptId={null} />);

    await userEvent.setup().click(screen.getByRole('link', { name: CALL_NOW_COPY.bookInstead }));

    expect(track).not.toHaveBeenCalled();
  });

  it('⚠ no Book a time when the expert is not bookable, or on the expert arm', () => {
    const { unmount } = render(<CallNowEndedCard {...BASE} bookInPage={false} />);
    expect(screen.queryByRole('link', { name: CALL_NOW_COPY.bookInstead })).toBeNull();
    expect(screen.getByRole('link', { name: CALL_NOW_COPY.backToCase })).toBeVisible();
    unmount();

    render(<CallNowEndedCard {...BASE} copyArm="expert" bookInPage />);
    expect(screen.queryByRole('link', { name: CALL_NOW_COPY.bookInstead })).toBeNull();
  });

  it('⚠ has no Cancel, carries no money, and passes axe', async () => {
    const container = renderCard();

    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
    expect(container.textContent ?? '').not.toMatch(/A\$|\/min/);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('exposes the heading for focus', () => {
    const headingRef = createRef<HTMLHeadingElement>();
    render(<CallNowEndedCard {...BASE} headingRef={headingRef} />);

    expect(headingRef.current).toBe(
      screen.getByRole('heading', { name: CALL_NOW_COPY.noAnswerTitle('Dana') })
    );
  });
});
