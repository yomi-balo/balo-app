import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import JoinLayout, { metadata } from './layout';
import {
  GUEST_CALL_VIEWPORT_ATTRIBUTE,
  GuestCallViewport,
} from '@/components/balo/meetings/guest-call-viewport';

describe('join layout', () => {
  /**
   * The whole reason this layout exists. `/join/{token}` carries a bearer token in the
   * PATH; without `no-referrer` any outbound request from this page would ship the token
   * in the `Referer` header, into request logs and into PostHog's `$referrer` on a
   * different page — where the `/join/` redaction cannot reach it.
   *
   * ⚠ And a join token is NOT single-use (desktop → phone → rejoin after a drop), so a
   * leaked copy stays replayable for the whole 7-day window rather than being spent.
   */
  it('sets a strict no-referrer policy for the whole subtree', () => {
    expect(metadata.referrer).toBe('no-referrer');
  });

  it('renders its children inside the public shell', () => {
    render(
      <JoinLayout>
        <p>Join body</p>
      </JoinLayout>
    );

    expect(screen.getByText('Join body')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  /**
   * An admitted guest's call must fill the viewport like a member's does, not sit in the
   * 560px invitation column. The layout keys that on the viewport's marker attribute, which it
   * has to spell literally (Tailwind only emits classes it can read) — so pin that the literal
   * still matches the component's attribute, or the call silently shrinks back into the column.
   */
  it('releases the narrow column for the guest call viewport', () => {
    render(
      <JoinLayout>
        <GuestCallViewport>
          <p>Call stage</p>
        </GuestCallViewport>
      </JoinLayout>
    );

    const main = screen.getByRole('main');
    expect(main).toHaveClass(
      `has-[[${GUEST_CALL_VIEWPORT_ATTRIBUTE}]]:max-w-none`,
      `has-[[${GUEST_CALL_VIEWPORT_ATTRIBUTE}]]:p-0`
    );
    expect(main.parentElement).toHaveClass(`has-[[${GUEST_CALL_VIEWPORT_ATTRIBUTE}]]:min-h-0`);

    const viewport = screen.getByText('Call stage').parentElement;
    expect(viewport).toHaveAttribute(GUEST_CALL_VIEWPORT_ATTRIBUTE);
    expect(viewport).toHaveClass('h-dvh', 'w-full');
  });
});
