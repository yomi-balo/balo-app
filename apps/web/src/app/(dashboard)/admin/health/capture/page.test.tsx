import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';

const { mockGetCurrentUser, mockRedirect, mockNotFound, mockLoadCaptureHealth } = vi.hoisted(
  () => ({
    mockGetCurrentUser: vi.fn(),
    mockRedirect: vi.fn(() => {
      throw new Error('NEXT_REDIRECT');
    }),
    mockNotFound: vi.fn(() => {
      throw new Error('NEXT_NOT_FOUND');
    }),
    mockLoadCaptureHealth: vi.fn(),
  })
);

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('next/navigation', () => ({
  redirect: mockRedirect,
  notFound: mockNotFound,
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => ({ toString: () => '' }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('./_lib/load-capture-health', () => ({ loadCaptureHealth: mockLoadCaptureHealth }));

import CaptureHealthPage from './page';

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-x',
    email: 'x@example.com',
    firstName: 'Dana',
    lastName: 'Whitfield',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'admin',
    ...overrides,
  } as SessionUser;
}

function emptyDto(overrides: Record<string, unknown> = {}) {
  return {
    rows: [],
    pinned: null,
    pinnedMissing: false,
    tiles: { recording: 0, transcription: 0, recap: 0, healthy: 0 },
    hasMore: false,
    nextCursor: null,
    isTrueZero: true,
    window: { fromIso: '2026-08-12', toIso: '2026-09-11', days: 30 },
    category: null,
    issueCount: 0,
    withheldBeforeIso: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

async function renderPage(
  searchParams: { category?: string; row?: string; from?: string; to?: string } = {}
) {
  const ui = await CaptureHealthPage({ searchParams: Promise.resolve(searchParams) });
  return render(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRedirect.mockImplementation(() => {
    throw new Error('NEXT_REDIRECT');
  });
  mockNotFound.mockImplementation(() => {
    throw new Error('NEXT_NOT_FOUND');
  });
});

describe('CaptureHealthPage — auth gate', () => {
  it('redirects to /login when there is no session', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockLoadCaptureHealth).not.toHaveBeenCalled();
  });

  it('404s a non-staff viewer', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ platformRole: 'user' }));
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockLoadCaptureHealth).not.toHaveBeenCalled();
  });
});

describe('CaptureHealthPage — error state', () => {
  it('a load failure is caught, logged with NO query text, and renders HealthErrorState', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockLoadCaptureHealth.mockRejectedValue(new Error('db down'));

    await renderPage({ category: 'recording' });

    expect(screen.getByText('Could not load capture health')).toBeInTheDocument();
    expect(log.error).toHaveBeenCalledWith(
      'Failed to load capture health',
      expect.objectContaining({ actorUserId: 'user-x', category: 'recording' })
    );
    const loggedPayload = vi.mocked(log.error).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(JSON.stringify(loggedPayload)).not.toContain('SELECT');
  });
});

describe('CaptureHealthPage — true-zero empty state', () => {
  it('renders the invitation copy when nothing has ever been recorded', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockLoadCaptureHealth.mockResolvedValue(emptyDto());

    await renderPage();

    expect(screen.getByText('Nothing has been recorded yet')).toBeInTheDocument();
  });
});

/**
 * BAL-550 web-review blocker — the client components below seed `useState` from server props, so
 * React MUST be told to remount them when the server read changes. Both the tiles and the window
 * control navigate within this route, which re-renders the page without unmounting anything.
 *
 * This asserts the KEY rather than the rendered output because the damage is invisible in a
 * single render: it only appears on the SECOND navigation, when `HealthList` would still hold
 * the previous filter's rows and — the part that corrupts data rather than just confusing —
 * the previous filter's CURSOR, paging one filter's rows into another.
 */
describe('CaptureHealthPage — client state is keyed to the server read', () => {
  /** Every `key` in the returned element tree, in render order. */
  function keysOf(node: unknown, found: string[] = []): string[] {
    if (Array.isArray(node)) {
      for (const child of node) keysOf(child, found);
      return found;
    }
    if (node === null || typeof node !== 'object') return found;
    const element = node as { key?: string | null; props?: { children?: unknown } };
    if (typeof element.key === 'string') found.push(element.key);
    if (element.props?.children !== undefined) keysOf(element.props.children, found);
    return found;
  }

  /** A row is required: with none, the page renders the filtered-empty state INSTEAD of the
   *  list, and the list's key — the one that matters most — would never be asserted at all. */
  const ROW = {
    meetingId: '11111111-1111-4111-8111-111111111111',
    title: 'Consultation 28 Aug 2026',
    parties: 'Bright Foods × Aisha Bello',
    when: '28 Aug',
    durationLabel: '42 min',
    contextLabel: 'case',
    recording: { state: 'ready' },
    transcription: { state: 'finished' },
    recap: { state: 'ready' },
    category: 'healthy',
    action: { kind: 'none' },
  };

  async function keysFor(searchParams: Record<string, string>, windowOverride: object) {
    mockGetCurrentUser.mockResolvedValue(user());
    mockLoadCaptureHealth.mockResolvedValue(
      emptyDto({ rows: [ROW], isTrueZero: false, window: windowOverride })
    );
    const ui = await CaptureHealthPage({ searchParams: Promise.resolve(searchParams) });
    return keysOf(ui);
  }

  const AUG = { fromIso: '2026-08-01', toIso: '2026-08-31', days: 31 };
  /** A DIFFERENT month of the SAME length — the case a `days`-based key cannot tell apart. */
  const JUL = { fromIso: '2026-07-01', toIso: '2026-07-31', days: 31 };

  it('changing the category changes the key, so the list cannot keep the old rows or cursor', async () => {
    const recording = await keysFor(
      { category: 'recording', from: '2026-08-01', to: '2026-08-31' },
      AUG
    );
    const recap = await keysFor({ category: 'recap', from: '2026-08-01', to: '2026-08-31' }, AUG);

    expect(recording).toContain('recording:2026-08-01:2026-08-31');
    expect(recap).toContain('recap:2026-08-01:2026-08-31');
    expect(recording).not.toEqual(recap);
  });

  it('two DIFFERENT windows of equal length get different keys (a `days` key would collide)', async () => {
    const august = await keysFor({ from: '2026-08-01', to: '2026-08-31' }, AUG);
    const july = await keysFor({ from: '2026-07-01', to: '2026-07-31' }, JUL);

    expect(august).toContain('all:2026-08-01:2026-08-31');
    expect(july).toContain('all:2026-07-01:2026-07-31');
    expect(august).not.toEqual(july);
  });

  it('all three stateful client components carry that key, not just one of them', async () => {
    const keys = await keysFor(
      { category: 'recording', from: '2026-08-01', to: '2026-08-31' },
      AUG
    );
    const viewKeys = keys.filter((k) => k === 'recording:2026-08-01:2026-08-31');
    // analytics + window control + list. A lower count means one was left unkeyed.
    expect(viewKeys).toHaveLength(3);
  });
});

describe('CaptureHealthPage — success state', () => {
  const HEALTHY_ROW = {
    meetingId: '11111111-1111-4111-8111-111111111111',
    title: 'Consultation 28 Aug 2026',
    parties: 'Bright Foods × Aisha Bello',
    when: '28 Aug',
    durationLabel: '42 min',
    contextLabel: 'case',
    recording: { state: 'ready' },
    transcription: { state: 'finished' },
    recap: { state: 'ready' },
    category: 'healthy',
    action: { kind: 'none' },
  };

  it('renders the tiles and the row list', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockLoadCaptureHealth.mockResolvedValue(
      emptyDto({
        rows: [HEALTHY_ROW],
        isTrueZero: false,
        tiles: { recording: 0, transcription: 0, recap: 0, healthy: 1 },
      })
    );

    await renderPage();

    expect(screen.getByText('Consultation 28 Aug 2026')).toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();
  });

  it('the ?row= deep link renders a pinned, highlighted band above the list, de-duplicated', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockLoadCaptureHealth.mockResolvedValue(
      emptyDto({
        rows: [],
        pinned: HEALTHY_ROW,
        isTrueZero: false,
      })
    );

    await renderPage({ row: HEALTHY_ROW.meetingId });

    expect(mockLoadCaptureHealth).toHaveBeenCalledWith(
      expect.objectContaining({ pinnedMeetingId: HEALTHY_ROW.meetingId })
    );
    expect(screen.getByText('Consultation 28 Aug 2026')).toBeInTheDocument();
  });

  it('an unknown ?row= renders the "no longer on this page" line', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockLoadCaptureHealth.mockResolvedValue(
      emptyDto({ rows: [], pinned: null, pinnedMissing: true, isTrueZero: false })
    );

    await renderPage({ row: '99999999-9999-4999-8999-999999999999' });

    expect(screen.getByText('That consultation is no longer on this page.')).toBeInTheDocument();
  });

  /**
   * ⚠⚠ A NON-UUID `?row=` NEVER REACHES POSTGRES. `findByMeetingId` compiles it into
   * `eq(meetings.id, …)`, and Postgres answers `22P02 invalid_text_representation` rather than
   * "no rows" — a throw this page's catch turns into the FULL-PAGE error state. `?row=x` would
   * therefore deny the whole lens to whoever opened the link. It resolves to the ordinary
   * "not found" answer instead, and the loader is never asked for it.
   */
  it('a malformed ?row= is treated as not-found, never as a load — and never errors the page', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockLoadCaptureHealth.mockResolvedValue(
      emptyDto({ rows: [], pinned: null, pinnedMissing: false, isTrueZero: false })
    );

    await renderPage({ row: 'x' });

    expect(mockLoadCaptureHealth).toHaveBeenCalledWith(
      expect.objectContaining({ pinnedMeetingId: null })
    );
    expect(screen.getByText('That consultation is no longer on this page.')).toBeInTheDocument();
    expect(screen.queryByText('Could not load capture health')).not.toBeInTheDocument();
  });

  it('a category filter with zero rows renders the filtered-empty state with "Back to all"', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockLoadCaptureHealth.mockResolvedValue(
      emptyDto({ rows: [], isTrueZero: false, category: 'recording' })
    );

    await renderPage({ category: 'recording' });

    expect(screen.getByText('Nothing in this window.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to all/ })).toBeInTheDocument();
  });
});

describe('CaptureHealthPage — the re-drive gate', () => {
  it('canRedrive threads through to disable the button for a platform admin (not super_admin)', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ platformRole: 'admin' }));
    mockLoadCaptureHealth.mockResolvedValue(
      emptyDto({
        rows: [
          {
            ...HEALTHY_ROW_FOR_REDRIVE(),
          },
        ],
        isTrueZero: false,
      })
    );

    await renderPage();

    const button = screen.getByRole('button', { name: /Re-drive ingest/ });
    expect(button).toBeDisabled();
  });
});

function HEALTHY_ROW_FOR_REDRIVE() {
  return {
    meetingId: '22222222-2222-4222-8222-222222222222',
    title: 'Consultation 30 Aug 2026',
    parties: 'Pacific Retail × Ravi Menon',
    when: '30 Aug',
    durationLabel: '47 min',
    contextLabel: 'case',
    recording: { state: 'failed', note: 'Mux asset errored' },
    transcription: { state: 'pending' },
    recap: { state: 'none' },
    category: 'recording',
    action: { kind: 'recording-ingest', recordingId: 'rec-9', segmentLabel: 'Segment 1 of 1' },
  };
}
