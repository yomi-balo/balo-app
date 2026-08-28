import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const RAW_TOKEN = 'k7Qm2ZtXpA9wLd3Vc1Rb8YvNhKsE0uJt';
const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const GUEST_ID = 'e0000000-0000-4000-8000-00000000000e';

const mockHeaders = vi.fn();
vi.mock('next/headers', () => ({ headers: () => mockHeaders() }));

// ⚠⚠ fix-round-1 / S4 — the page no longer calls `checkMemoryLimit` directly (its own
// `guest-recap-page:` limiter was dropped: it shared key material and budget with the
// loader's `guest-recap:ip:`, so it could never trip without that one tripping too). Nothing
// here mocks `@/lib/rate-limit/memory-window` any more — throttling is entirely the loader's
// concern, and `mockLoad.mockResolvedValue(null)` already covers every shape it collapses to,
// throttled or otherwise.

const mockLoad = vi.fn();
vi.mock('../_lib/load-guest-recap', () => ({
  loadGuestRecap: (...a: unknown[]) => mockLoad(...a),
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', async () => {
  const events = await import('@balo/analytics/events');
  return {
    trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
    GUEST_SERVER_EVENTS: events.GUEST_SERVER_EVENTS,
  };
});

// ⚠ NOT reached by page.tsx directly, but transitively by GuestRecapCard → GuestRecapFiles.
// Mocked so the client island never touches the real `@balo/db`-backed action module.
const mockListFiles = vi.fn();
vi.mock('../../../_actions/list-guest-meeting-files', () => ({
  listGuestMeetingFilesAction: (...a: unknown[]) => mockListFiles(...a),
}));
const mockDownloadFile = vi.fn();
vi.mock('../../../_actions/get-guest-meeting-file-download', () => ({
  getGuestMeetingFileDownloadAction: (...a: unknown[]) => mockDownloadFile(...a),
}));

import GuestRecapPage from './page';

/** ⚠ `params` is a PROMISE — apps/web is Next 16. A plain object here would false-green. */
function pageProps(
  token = RAW_TOKEN,
  meetingId = MEETING_ID
): { params: Promise<{ token: string; meetingId: string }> } {
  return { params: Promise.resolve({ token, meetingId }) };
}

const VIEW_RESULT = {
  view: {
    meetingId: MEETING_ID,
    header: {
      contextLabel: 'Consultation',
      occurredAtIso: '2026-08-01T10:00:00.000Z',
      durationMinutes: 32,
    },
    summary: { state: 'ready' as const, content: 'A great call, thanks everyone.' },
    isOwnMeeting: true,
  },
  guestId: GUEST_ID,
  accessScope: 'meeting' as const,
};

/**
 * ⚠ ON A SUCCESSFUL RENDER, `GuestRecapFiles` (the one client island) fetches its list on
 * mount — settle that microtask before returning, so assertions run against the SETTLED tree
 * and no test leaves an `act()` warning for a state update nobody awaited.
 */
async function renderPage(props = pageProps()): Promise<HTMLElement> {
  const { container } = render(await GuestRecapPage(props));
  if (screen.queryByText('Files') !== null) {
    await waitFor(() => {
      expect(screen.queryByTestId('panel-skeleton')).not.toBeInTheDocument();
    });
  }
  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHeaders.mockResolvedValue(new Headers({ 'x-forwarded-for': '1.2.3.4' }));
  mockListFiles.mockResolvedValue({ success: true, files: [] });
});

describe('GuestRecapPage', () => {
  it('`params` is a Promise and is awaited (Next 16)', async () => {
    mockLoad.mockResolvedValue(VIEW_RESULT);
    await expect(renderPage()).resolves.toBeDefined();
  });

  it('renders the recap card on success — context label, date, duration, summary and Files', async () => {
    mockLoad.mockResolvedValue(VIEW_RESULT);
    const container = await renderPage();

    expect(container.textContent).toContain('Consultation');
    expect(container.textContent).toContain('A great call, thanks everyone.');
    expect(container.textContent).toContain('32 min');
    expect(screen.getByText('Files')).toBeInTheDocument();
  });

  /**
   * ⚠⚠ fix-round-1 / MUST-4 — the `!isOwnMeeting` branch's retrospective note ("This call is
   * part of the same piece of work you were invited to.") is the ONLY user-visible difference
   * for an engagement-scope retrospective read — this ticket's headline grant — and until now
   * `VIEW_RESULT`'s only fixture value was `isOwnMeeting: true`, so the line was never rendered
   * in any test.
   */
  it('⚠⚠ MUST-4 — renders the retrospective note when isOwnMeeting is false', async () => {
    mockLoad.mockResolvedValue({
      ...VIEW_RESULT,
      view: { ...VIEW_RESULT.view, isOwnMeeting: false },
    });
    const container = await renderPage();

    expect(container.textContent).toContain(
      'This call is part of the same piece of work you were invited to.'
    );
  });

  it('⚠⚠ MUST-4 — omits the retrospective note when isOwnMeeting is true', async () => {
    mockLoad.mockResolvedValue(VIEW_RESULT);
    const container = await renderPage();

    expect(container.textContent).not.toContain(
      'This call is part of the same piece of work you were invited to.'
    );
  });

  it('passes the Zod-validated token/meetingId straight to the loader', async () => {
    mockLoad.mockResolvedValue(VIEW_RESULT);
    await renderPage();

    expect(mockLoad).toHaveBeenCalledWith({
      rawToken: RAW_TOKEN,
      meetingId: MEETING_ID,
      clientIpHash: expect.any(String),
    });
  });

  it('fires `GUEST_RECAP_VIEWED` on a SUCCESSFUL render only', async () => {
    mockLoad.mockResolvedValue(VIEW_RESULT);
    await renderPage();

    expect(mockTrack).toHaveBeenCalledWith('guest_recap_viewed', {
      access_scope: 'meeting',
      is_own_meeting: true,
      summary_state: 'ready',
      days_since_meeting: expect.any(Number),
      distinct_id: GUEST_ID,
    });
  });

  /**
   * ⚠⚠ fix-round-1 / S6 (R12) — `days_since_meeting` is computed at the PAGE, from
   * `view.header.occurredAtIso` (`2026-08-01T10:00:00.000Z` on `VIEW_RESULT`), never inside
   * `resolveGuestSummary`. Pinned with a fixed clock so the expected count is exact rather
   * than `expect.any(Number)`.
   */
  it('⚠⚠ S6 — `days_since_meeting` is the whole-day floor from the meeting`s timestamp to now', async () => {
    // `shouldAdvanceTime` — `waitFor`'s internal polling still needs REAL time to progress;
    // only `Date.now()` / `new Date()` are pinned to the fake system time.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-08-06T10:00:00.000Z')); // exactly 5 days after occurredAtIso
    mockLoad.mockResolvedValue(VIEW_RESULT);

    await renderPage();

    expect(mockTrack).toHaveBeenCalledWith(
      'guest_recap_viewed',
      expect.objectContaining({ days_since_meeting: 5 })
    );
    vi.useRealTimers();
  });

  it('⚠ never fires analytics on a denial — a denial event keyed on a crafted token would itself be a signal', async () => {
    mockLoad.mockResolvedValue(null);
    await renderPage();

    expect(mockTrack).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ THE ACCEPTANCE CRITERION. A malformed `meetingId`, a malformed token, and every shape
   * the LOADER collapses to `null` (unresolvable token, out-of-scope meeting, pending
   * admission, a meeting that has not `ended`, EITHER of its own two rate limiters tripping)
   * must render BYTE-IDENTICAL markup, or the page is an existence oracle against a URL a
   * guest may present repeatedly.
   *
   * ⚠⚠ fix-round-1 / S4 — the page's OWN throttle case was dropped from this list along with
   * the limiter itself. It is not a coverage loss: a throttled request is now just one more
   * shape the loader collapses to `null`, already exercised by the loop below — there is no
   * longer a page-level bail-out distinct from that.
   */
  it('⚠⚠ renders BYTE-IDENTICAL markup for every denial shape — no oracle', async () => {
    const markup: string[] = [];

    // 1. malformed meetingId — not a UUID. Would throw Postgres 22P02 if it ever reached a
    //    repository; Zod must catch it first.
    markup.push((await renderPage(pageProps(RAW_TOKEN, 'not-a-uuid'))).innerHTML);

    // 2. malformed token — under the 20-char floor.
    markup.push((await renderPage(pageProps('short', MEETING_ID))).innerHTML);

    // 3-6. every shape the LOADER itself collapses to null: unresolvable token, out-of-scope
    //    meeting, pending admission, not-yet-`ended` meeting, either internal rate limiter.
    mockLoad.mockResolvedValue(null);
    for (let i = 0; i < 4; i += 1) {
      markup.push((await renderPage()).innerHTML);
    }

    expect(markup).toHaveLength(6);
    expect(new Set(markup).size).toBe(1);
    expect(markup[0]).toContain("This link isn't active");
  });
});

describe('GuestRecapPage — concealment on a successful render', () => {
  beforeEach(() => {
    mockLoad.mockResolvedValue(VIEW_RESULT);
  });

  it('⚠⚠ no "@" anywhere in the rendered text — the strictest rule, no email of anybody', async () => {
    const container = await renderPage();
    expect(container.textContent ?? '').not.toContain('@');
  });

  it('no money block — no charge, no A$, no invoice, no earned, no rate', async () => {
    const container = await renderPage();
    expect(screen.queryByText(/charge|A\$|invoice|earned|rate/i)).toBeNull();
    expect(container.textContent ?? '').not.toMatch(/charge|A\$|invoice|earned|rate/i);
  });

  it('no counterparty name, no agency name, no company name, no "Other guests" row', async () => {
    const container = await renderPage();
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/other guests/i);
    expect(text).not.toMatch(/northwind|cloudpeak/i);
  });

  it('no "Read the transcript" / "Action items" / "Resolve" affordance', async () => {
    const container = await renderPage();
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/read the transcript/i);
    expect(text).not.toMatch(/action items?/i);
    expect(text).not.toMatch(/\bresolve\b/i);
  });

  it('no recording playback affordance', async () => {
    const container = await renderPage();
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/play recording|recording/i);
  });
});
