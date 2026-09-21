import { Suspense } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { axe } from 'jest-axe';

import GuestRecapIndexLoading from './loading';
import MeetingRecapLoading from './[meetingId]/loading';

/** Suspends forever — used below to force a Suspense boundary's fallback to render. */
function NeverResolves(): React.JSX.Element {
  throw new Promise(() => {
    // deliberately never settles
  });
}

/**
 * BAL-492 — mirrors `[meetingId]/loading.test.tsx` exactly: `<output>` (never `role="status"`,
 * SonarCloud S6819), `aria-busy` on the decorative wrapper only, and an axe pass.
 */
describe('GuestRecapIndexLoading', () => {
  it('announces itself instead of rendering a silent empty page', () => {
    render(<GuestRecapIndexLoading />);

    const region = screen.getByRole('status');
    expect(region.tagName).toBe('OUTPUT');
    expect(region).toHaveTextContent('Loading your recaps');
  });

  it('⚠⚠ aria-busy is on the DECORATIVE wrapper, NEVER on the <output>', () => {
    const { container } = render(<GuestRecapIndexLoading />);

    expect(screen.getByRole('status').getAttribute('aria-busy')).toBeNull();
    expect(container.querySelectorAll('div[aria-busy="true"]')).toHaveLength(1);
  });

  it('names nothing that the loader would have resolved', () => {
    const { container } = render(<GuestRecapIndexLoading />);

    expect(container.textContent).toBe('Loading your recaps…');
  });

  it('has no axe violations', async () => {
    const { container } = render(<GuestRecapIndexLoading />);

    expect(await axe(container)).toHaveNoViolations();
  });

  /**
   * BAL-492 — neither `recap/` nor `recap/[meetingId]/` has its own `layout.tsx` (only
   * `app/join/[token]/layout.tsx` does, above both). Next's App Router still wraps each
   * segment's own implicit layout output in that segment's OWN `loading.js` Suspense boundary,
   * nested inside the parent's. Rendering the two boundaries nested here, exactly as Next
   * composes them for a direct navigation to `/join/{token}/recap/{meetingId}`, is the closest a
   * component test can get to proving the child boundary — the nearer ancestor to the suspending
   * page — intercepts first, so this index's "Loading your recaps…" never flashes en route to a
   * single meeting's recap.
   */
  it('the [meetingId] segment`s own loading.tsx intercepts before this one when nested, matching how Next composes per-segment Suspense boundaries', () => {
    render(
      <Suspense fallback={<GuestRecapIndexLoading />}>
        <Suspense fallback={<MeetingRecapLoading />}>
          <NeverResolves />
        </Suspense>
      </Suspense>
    );

    expect(screen.getByText('Loading the recap…')).toBeInTheDocument();
    expect(screen.queryByText('Loading your recaps…')).not.toBeInTheDocument();
  });
});
