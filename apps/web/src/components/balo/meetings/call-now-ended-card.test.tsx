import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from '@/test/axe';
import { CALL_NOW_COPY } from '@/lib/call-now/call-now-copy';
import { CallNowEndedCard, type CallNowEndedCardProps } from './call-now-ended-card';

const ENGAGEMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const BASE: CallNowEndedCardProps = {
  outcome: 'unanswered',
  calleeLabel: 'Dana',
  copyArm: 'client',
  bookInPage: true,
  engagementId: ENGAGEMENT_ID,
};

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
