import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import JoinLayout, { metadata } from './layout';

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
});
