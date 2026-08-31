import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { track, MARKETING_HOME_EVENTS } from '@/lib/analytics';
import { CtaLink } from './cta-link';

const mockTrack = vi.mocked(track);

beforeEach(() => {
  mockTrack.mockClear();
});

/**
 * BAL-493 fix round 2 (review MAJOR 6) — `cta-link.tsx` had no emitter test at all. `CtaLink`
 * is the ONE `<Link>` every CTA on the home page renders through, so this is the single place
 * `marketing_home_cta_clicked` needs pinning — every call site (e.g. `experts-section.tsx`'s two
 * CTAs) composes this component rather than calling `track()` itself.
 */
describe('CtaLink — fires marketing_home_cta_clicked exactly once (AC-6)', () => {
  it('emits the placement and label on click, and still navigates via the real <a href>', async () => {
    const user = userEvent.setup();
    render(
      <CtaLink placement="final" label="Find an expert" href="/experts">
        Find an expert
      </CtaLink>
    );

    const link = screen.getByRole('link', { name: 'Find an expert' });
    expect(link).toHaveAttribute('href', '/experts');

    await user.click(link);

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.CTA_CLICKED, {
      placement: 'final',
      label: 'Find an expert',
    });
  });

  it('emits a DIFFERENT placement/label pair for a different CTA — the bag is not hardcoded', async () => {
    const user = userEvent.setup();
    render(
      <CtaLink placement="experts" label="Browse all experts" href="/experts">
        Browse all experts
      </CtaLink>
    );

    await user.click(screen.getByRole('link', { name: 'Browse all experts' }));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.CTA_CLICKED, {
      placement: 'experts',
      label: 'Browse all experts',
    });
  });

  it('does not fire before any click', () => {
    render(
      <CtaLink placement="ways" label="Browse experts" href="/experts">
        Browse experts
      </CtaLink>
    );
    expect(mockTrack).not.toHaveBeenCalled();
  });
});
