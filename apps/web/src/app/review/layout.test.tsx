import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import ReviewLayout, { metadata } from './layout';

describe('review layout', () => {
  /**
   * The whole reason this layout exists. `/review/{token}` carries a bearer token in the
   * PATH; without `no-referrer` the "Sign in" navigation off the success state would ship
   * the token in the `Referer` header, into request logs and into PostHog's `$referrer`
   * on a different page — where the `/review/` redaction cannot reach it.
   */
  it('sets a strict no-referrer policy for the whole subtree', () => {
    expect(metadata.referrer).toBe('no-referrer');
  });

  it('renders its children inside the public shell', () => {
    render(
      <ReviewLayout>
        <p>Review body</p>
      </ReviewLayout>
    );

    expect(screen.getByText('Review body')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });
});
