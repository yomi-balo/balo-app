import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const RAW_TOKEN = 'k7Qm2ZtXpA9wLd3Vc1Rb8YvNhKsE0uJt';
const MEETING_ID_1 = 'a0000000-0000-4000-8000-000000000001';
const MEETING_ID_2 = 'a0000000-0000-4000-8000-000000000002';
const OWN_MEETING_ID = 'a0000000-0000-4000-8000-000000000009';
const GUEST_ID = 'e0000000-0000-4000-8000-00000000000e';

const mockHeaders = vi.fn();
vi.mock('next/headers', () => ({ headers: () => mockHeaders() }));

// ⚠ `redirect` throws (mirroring Next's NEXT_REDIRECT control-flow throw) so callers past it
// never execute — the `(onboarding)/join-result/page.test.tsx` precedent.
const { mockRedirect } = vi.hoisted(() => ({
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock('next/navigation', () => ({ redirect: mockRedirect }));

const mockLoad = vi.fn();
vi.mock('./_lib/load-guest-recap-index', () => ({
  loadGuestRecapIndex: (...a: unknown[]) => mockLoad(...a),
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', async () => {
  const events = await import('@balo/analytics/events');
  return {
    trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
    GUEST_SERVER_EVENTS: events.GUEST_SERVER_EVENTS,
  };
});

import GuestRecapIndexPage, { metadata } from './page';
import {
  GUEST_RECAP_INDEX_EMPTY_BODY,
  GUEST_RECAP_INDEX_EMPTY_TITLE,
} from './_components/guest-recap-index-card';

/** ⚠ `params` is a PROMISE — apps/web is Next 16. A plain object here would false-green. */
function pageProps(token = RAW_TOKEN): { params: Promise<{ token: string }> } {
  return { params: Promise.resolve({ token }) };
}

const ROWS_RESULT = {
  kind: 'index' as const,
  rows: [
    {
      meetingId: MEETING_ID_1,
      contextLabel: 'Consultation',
      occurredAtIso: '2026-08-01T10:00:00.000Z',
      durationMinutes: 32,
    },
    {
      meetingId: MEETING_ID_2,
      contextLabel: 'Intro call',
      occurredAtIso: '2026-07-15T09:00:00.000Z',
      durationMinutes: null,
    },
  ],
  guestId: GUEST_ID,
};

const EMPTY_RESULT = { kind: 'index' as const, rows: [], guestId: GUEST_ID };

async function renderPage(props = pageProps()): Promise<HTMLElement> {
  const { container } = render(await GuestRecapIndexPage(props));
  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHeaders.mockResolvedValue(new Headers({ 'x-forwarded-for': '1.2.3.4' }));
});

describe('GuestRecapIndexPage', () => {
  it('is noindex', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it('malformed token (too short) — LinkNotActive, loader called zero times', async () => {
    const container = await renderPage(pageProps('short'));

    expect(container.textContent).toContain("This link isn't active");
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('loader returns null — LinkNotActive, redirect called zero times, no analytics event', async () => {
    mockLoad.mockResolvedValue(null);

    const container = await renderPage();

    expect(container.textContent).toContain("This link isn't active");
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('⚠⚠ D2 — a redirect result throws NEXT_REDIRECT to exactly the anchor recap path, no analytics', async () => {
    mockLoad.mockResolvedValue({
      kind: 'redirect',
      href: `/join/${RAW_TOKEN}/recap/${OWN_MEETING_ID}`,
    });

    await expect(renderPage()).rejects.toThrow(
      `REDIRECT:/join/${RAW_TOKEN}/recap/${OWN_MEETING_ID}`
    );
    expect(mockRedirect).toHaveBeenCalledWith(`/join/${RAW_TOKEN}/recap/${OWN_MEETING_ID}`);
    expect(mockTrack).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ Pins the PAGE's OWN `result.kind === 'redirect'` branch, not the loader (mocked in this
   * file). Together with the D2 case above — which relies on the redirect actually firing — this
   * proves that branch discriminates on `kind` rather than firing (or not) unconditionally.
   */
  it('⚠ non-vacuity: a resolved index result does NOT trigger a redirect', async () => {
    mockLoad.mockResolvedValue(EMPTY_RESULT);

    await renderPage();

    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('successful render with rows fires GUEST_RECAP_INDEX_VIEWED with the exact object', async () => {
    mockLoad.mockResolvedValue(ROWS_RESULT);

    await renderPage();

    expect(mockTrack).toHaveBeenCalledWith('guest_recap_index_viewed', {
      meeting_count: 2,
      distinct_id: GUEST_ID,
    });
  });

  it('renders exactly the three disclosed primitives per row — a planted title/counterparty on the loader input never reaches the rendered text', async () => {
    const plantedRows = ROWS_RESULT.rows.map((row) => ({
      ...row,
      title: 'Q3 Strategy Review',
      counterparty: 'Acme Corp',
    })) as unknown as typeof ROWS_RESULT.rows;
    mockLoad.mockResolvedValue({ ...ROWS_RESULT, rows: plantedRows });

    const container = await renderPage();

    expect(container.textContent).toContain('Consultation');
    expect(container.textContent).toContain('32 min');
    expect(container.textContent).toContain('Intro call');
    expect(screen.getAllByRole('link', { name: /consultation|intro call/i })).toHaveLength(2);
    expect(container.textContent).not.toContain('Q3 Strategy Review');
    expect(container.textContent).not.toContain('Acme Corp');
  });

  it('empty authorised index renders the empty-state copy (full literals) — not a denial', async () => {
    mockLoad.mockResolvedValue(EMPTY_RESULT);

    const container = await renderPage();

    expect(container.textContent).toContain(GUEST_RECAP_INDEX_EMPTY_TITLE);
    expect(container.textContent).toContain(GUEST_RECAP_INDEX_EMPTY_BODY);
    expect(container.textContent).not.toContain("This link isn't active");
    expect(mockTrack).toHaveBeenCalledWith('guest_recap_index_viewed', {
      meeting_count: 0,
      distinct_id: GUEST_ID,
    });
  });

  it('passes the Zod-validated token straight to the loader, with an ip hash', async () => {
    mockLoad.mockResolvedValue(EMPTY_RESULT);

    await renderPage();

    expect(mockLoad).toHaveBeenCalledWith({
      rawToken: RAW_TOKEN,
      clientIpHash: expect.any(String),
    });
  });

  it('⚠⚠ renders BYTE-IDENTICAL LinkNotActive markup for a malformed token and a loader null', async () => {
    const markup: string[] = [];

    markup.push((await renderPage(pageProps('short'))).innerHTML);

    mockLoad.mockResolvedValue(null);
    markup.push((await renderPage()).innerHTML);

    expect(markup).toHaveLength(2);
    expect(new Set(markup).size).toBe(1);
    expect(markup[0]).toContain("This link isn't active");
  });
});
