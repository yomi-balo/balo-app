import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import { axe } from 'jest-axe';
import {
  GUEST_RECAP_INDEX_EMPTY_BODY,
  GUEST_RECAP_INDEX_EMPTY_TITLE,
  GUEST_RECAP_INDEX_TITLE,
  GuestRecapIndexCard,
} from './guest-recap-index-card';
import type { GuestRecapIndexRowView } from '../_lib/guest-recap-index-view-types';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

vi.mock('next/link', () => ({
  default: ({
    href,
    prefetch,
    children,
    ...rest
  }: {
    href: string;
    prefetch?: boolean;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));

const TOKEN = 'k7Qm2ZtXpA9wLd3Vc1Rb8YvNhKsE0uJt';

const FIRST_ROW: GuestRecapIndexRowView = {
  meetingId: 'a0000000-0000-4000-8000-000000000001',
  contextLabel: 'Consultation',
  occurredAtIso: '2026-08-01T10:00:00.000Z',
  durationMinutes: 32,
};
const SECOND_ROW: GuestRecapIndexRowView = {
  meetingId: 'a0000000-0000-4000-8000-000000000002',
  contextLabel: 'Intro call',
  occurredAtIso: '2026-07-15T09:00:00.000Z',
  durationMinutes: null,
};
// ⚠ A TUPLE, NOT `GuestRecapIndexRowView[]` — under `noUncheckedIndexedAccess` a literal
// numeric index into a fixed-length tuple is exempt from the `| undefined` widening that a
// plain array index would carry, so `ROWS[0]` below needs no non-null assertion (a Sonar
// false positive the repo avoids by shape rather than by `!`).
const ROWS: readonly [GuestRecapIndexRowView, GuestRecapIndexRowView] = [FIRST_ROW, SECOND_ROW];

describe('GuestRecapIndexCard', () => {
  it('renders one link per row, in the order given', () => {
    render(<GuestRecapIndexCard rows={ROWS} token={TOKEN} />);

    const rowLinks = screen.getAllByRole('link', { name: /consultation|intro call/i });
    expect(rowLinks).toHaveLength(2);
    expect(rowLinks[0]).toHaveAttribute('href', `/join/${TOKEN}/recap/${FIRST_ROW.meetingId}`);
    expect(rowLinks[1]).toHaveAttribute('href', `/join/${TOKEN}/recap/${SECOND_ROW.meetingId}`);
  });

  it('every row link carries prefetch={false}', () => {
    render(<GuestRecapIndexCard rows={ROWS} token={TOKEN} />);

    const rowLinks = screen.getAllByRole('link', { name: /consultation|intro call/i });
    expect(rowLinks).toHaveLength(2);
    expect(rowLinks.every((l) => l.getAttribute('data-prefetch') === 'false')).toBe(true);
  });

  it('durationMinutes: null renders no duration text and never "0 min"', () => {
    render(<GuestRecapIndexCard rows={ROWS} token={TOKEN} />);

    expect(screen.queryByText(/0 min/)).not.toBeInTheDocument();
    expect(screen.getByText('32 min')).toBeInTheDocument();
  });

  it('renders the heading', () => {
    render(<GuestRecapIndexCard rows={ROWS} token={TOKEN} />);
    expect(screen.getByRole('heading', { name: GUEST_RECAP_INDEX_TITLE })).toBeInTheDocument();
  });

  it('empty rows — renders the empty state and ZERO row links; only "Back to the invitation" remains', () => {
    render(<GuestRecapIndexCard rows={[]} token={TOKEN} />);

    expect(screen.getByText(GUEST_RECAP_INDEX_EMPTY_TITLE)).toBeInTheDocument();
    expect(screen.getByText(GUEST_RECAP_INDEX_EMPTY_BODY)).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent(/back to the invitation/i);
  });

  it('MUTATION PROOF: heading and empty-state copy constants are the full literal', () => {
    expect(GUEST_RECAP_INDEX_TITLE).toBe('Your recaps');
    expect(GUEST_RECAP_INDEX_EMPTY_TITLE).toBe('No recaps to open');
    expect(GUEST_RECAP_INDEX_EMPTY_BODY).toBe(
      "Recaps appear here once a call has finished. You'll get an email link for any call you're invited to."
    );
  });

  it('every row link has the min-h-11 tap target class', () => {
    render(<GuestRecapIndexCard rows={ROWS} token={TOKEN} />);

    const rowLinks = screen.getAllByRole('link', { name: /consultation|intro call/i });
    expect(rowLinks).toHaveLength(2);
    for (const link of rowLinks) {
      expect(link.className).toContain('min-h-11');
    }
  });

  it('the back link also carries prefetch={false}', () => {
    render(<GuestRecapIndexCard rows={[]} token={TOKEN} />);

    const backLink = screen.getByRole('link', { name: /back to the invitation/i });
    expect(backLink).toHaveAttribute('data-prefetch', 'false');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<GuestRecapIndexCard rows={ROWS} token={TOKEN} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no accessibility violations on the empty state', async () => {
    const { container } = render(<GuestRecapIndexCard rows={[]} token={TOKEN} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
