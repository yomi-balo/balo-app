import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import { axe } from 'jest-axe';
import {
  GUEST_RECAP_ENVELOPE_NOTE,
  GUEST_RECAP_INDEX_LINK_LABEL,
  GuestRecapCard,
} from './guest-recap-card';
import type { GuestRecapView } from '../_lib/guest-recap-view-types';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

// ⚠⚠ `next/link`'s `prefetch` prop does not surface as a DOM attribute — mocked here so the
// per-link tests below can assert it directly on each rendered anchor.
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

// ⚠ The Files card fetches on mount via a Server Action; mocked so it never reaches @balo/db.
const mockListFiles = vi.fn();
vi.mock('../../../_actions/list-guest-meeting-files', () => ({
  listGuestMeetingFilesAction: (...a: unknown[]) => mockListFiles(...a),
}));
const mockDownloadFile = vi.fn();
vi.mock('../../../_actions/get-guest-meeting-file-download', () => ({
  getGuestMeetingFileDownloadAction: (...a: unknown[]) => mockDownloadFile(...a),
}));

const TOKEN = 'k7Qm2ZtXpA9wLd3Vc1Rb8YvNhKsE0uJt';
const INDEX_HREF = `/join/${TOKEN}/recap`;
const EXISTING_SENTENCE = 'This call is part of the same piece of work you were invited to.';

const BASE_VIEW: GuestRecapView = {
  meetingId: 'a0000000-0000-4000-8000-000000000001',
  header: {
    contextLabel: 'Consultation',
    occurredAtIso: '2026-08-01T10:00:00.000Z',
    durationMinutes: 32,
  },
  summary: { state: 'ready', content: 'A great call, thanks everyone.' },
  isOwnMeeting: true,
};

beforeEach(() => {
  mockListFiles.mockResolvedValue({ success: true, files: [] });
});

/** ⚠ `GuestRecapFiles` (a client island) fetches on mount — settle that microtask before
 *  returning, so no test leaves an `act()` warning for a state update nobody awaited (the
 *  `[meetingId]/page.test.tsx` `renderPage` pattern, applied here). */
async function renderCard(
  props: React.ComponentProps<typeof GuestRecapCard>
): Promise<ReturnType<typeof render>> {
  const result = render(<GuestRecapCard {...props} />);
  await waitFor(() => expect(mockListFiles).toHaveBeenCalled());
  return result;
}

describe('GuestRecapCard — BAL-492 onward affordance', () => {
  it('isOwnMeeting: true, indexHref: null — neither paragraph nor index link renders', async () => {
    await renderCard({ view: BASE_VIEW, token: TOKEN, indexHref: null });

    expect(screen.queryByText(GUEST_RECAP_ENVELOPE_NOTE)).not.toBeInTheDocument();
    expect(screen.queryByText(EXISTING_SENTENCE)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: GUEST_RECAP_INDEX_LINK_LABEL })
    ).not.toBeInTheDocument();
  });

  it('isOwnMeeting: true, indexHref set — the envelope note and index link render; existing sentence does not', async () => {
    await renderCard({ view: BASE_VIEW, token: TOKEN, indexHref: INDEX_HREF });

    expect(screen.getByText(GUEST_RECAP_ENVELOPE_NOTE)).toBeInTheDocument();
    expect(screen.queryByText(EXISTING_SENTENCE)).not.toBeInTheDocument();
    const link = screen.getByRole('link', { name: GUEST_RECAP_INDEX_LINK_LABEL });
    expect(link).toHaveAttribute('href', INDEX_HREF);
  });

  it('isOwnMeeting: false, indexHref set — the EXISTING sentence and the index link co-occur', async () => {
    await renderCard({
      view: { ...BASE_VIEW, isOwnMeeting: false },
      token: TOKEN,
      indexHref: INDEX_HREF,
    });

    expect(screen.getByText(EXISTING_SENTENCE)).toBeInTheDocument();
    expect(screen.queryByText(GUEST_RECAP_ENVELOPE_NOTE)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: GUEST_RECAP_INDEX_LINK_LABEL })).toBeInTheDocument();
  });

  it('isOwnMeeting: false, indexHref: null — the existing sentence renders, no link', async () => {
    await renderCard({
      view: { ...BASE_VIEW, isOwnMeeting: false },
      token: TOKEN,
      indexHref: null,
    });

    expect(screen.getByText(EXISTING_SENTENCE)).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: GUEST_RECAP_INDEX_LINK_LABEL })
    ).not.toBeInTheDocument();
  });

  it('⚠⚠ per-link prefetch={false} — the index link AND the back link both carry it', async () => {
    await renderCard({ view: BASE_VIEW, token: TOKEN, indexHref: INDEX_HREF });

    const indexLink = screen.getByRole('link', { name: GUEST_RECAP_INDEX_LINK_LABEL });
    expect(indexLink).toHaveAttribute('data-prefetch', 'false');
    const backLink = screen.getByRole('link', { name: /back to the invitation/i });
    expect(backLink).toHaveAttribute('data-prefetch', 'false');
  });

  it('durationMinutes: null renders no duration text', async () => {
    const { container } = await renderCard({
      view: { ...BASE_VIEW, header: { ...BASE_VIEW.header, durationMinutes: null } },
      token: TOKEN,
      indexHref: null,
    });

    expect(container.textContent).not.toContain(' min');
  });

  it('MUTATION PROOF: pinned copy constants are asserted against the FULL literal', () => {
    expect(GUEST_RECAP_ENVELOPE_NOTE).toBe(
      'You were invited to a piece of work, not just this call.'
    );
    expect(GUEST_RECAP_INDEX_LINK_LABEL).toBe('Browse the recaps you can open');
  });

  it('has no accessibility violations', async () => {
    const { container } = await renderCard({
      view: BASE_VIEW,
      token: TOKEN,
      indexHref: INDEX_HREF,
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});
