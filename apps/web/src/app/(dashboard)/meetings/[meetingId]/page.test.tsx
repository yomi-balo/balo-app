import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { RecapView } from '@/lib/meetings/recap-view-types';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const USER_ID = 'b0000000-0000-4000-8000-000000000002';
const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000005';

vi.mock('server-only', () => ({}));

// Motion is mocked away: `motion/react` misbehaves under JSDOM, and the entrance animation is
// not what any assertion here is about.
vi.mock('motion/react', () => ({
  motion: {
    div: (props: Record<string, unknown>) => <div>{props.children as React.ReactNode}</div>,
  },
  useReducedMotion: () => true,
}));

const notFoundError = new Error('NEXT_NOT_FOUND');
const redirectError = new Error('NEXT_REDIRECT');
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw notFoundError;
  },
  redirect: () => {
    throw redirectError;
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

const mockLoadRecap = vi.fn();
vi.mock('./_lib/load-recap', () => ({
  loadRecap: (...a: unknown[]) => mockLoadRecap(...a),
}));

const mockTrack = vi.fn();
// ⚠ THE CONSTANTS COME FROM SOURCE, NOT A HAND-RESTATED LITERAL. `apps/web/src/test/setup.ts`
// sets the precedent ("so the mock stays in sync with source"): a rename in
// `packages/analytics/src/events/recap.ts` must fail HERE rather than leave a green suite
// asserting an event name nothing emits.
vi.mock('@/lib/analytics/server', async () => {
  const events = await import('@balo/analytics/events');
  return {
    trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
    RECAP_SERVER_EVENTS: events.RECAP_SERVER_EVENTS,
  };
});

vi.mock('./_actions/resolve-case', () => ({ resolveCaseAction: vi.fn() }));
vi.mock('./_actions/dismiss-resolution-request', () => ({
  dismissResolutionRequestAction: vi.fn(),
}));
vi.mock('./_actions/get-meeting-file-download', () => ({
  getMeetingFileDownloadAction: vi.fn(),
}));

import RecapPage, { generateMetadata } from './page';

const BASE = {
  meetingId: MEETING_ID,
  contextType: 'case' as const,
  state: 'ready' as const,
  header: {
    eyebrow: 'Consultation',
    // BAL-421 — a `case` recap now links back to its case surface.
    caseHref: '/cases/' + ENGAGEMENT_ID,
    title: 'Flow interview stuck on a record-triggered loop',
    status: { label: 'Completed', tone: 'success' as const, icon: 'check' as const },
    closedNote: null,
    occurredAtIso: '2026-07-29T04:14:00.000Z',
    durationMinutes: 45,
    openActionItemCount: 1,
    totalActionItemCount: 3,
  },
  money: { kind: 'absent' as const },
  artifacts: {
    summary: { state: 'ready' as const, content: 'We agreed to rebuild the flow.' },
    transcript: { state: 'ready' as const, content: 'Amara: hello there.' },
    collapsed: false,
  },
  actionItems: null,
  party: {
    name: 'Amara Okafor',
    headline: 'Salesforce CPQ specialist',
    orgLabel: 'CloudPeak',
    avatarUrl: null,
    initials: 'AO',
    ordinalLine: '3rd consultation on this case',
    bookAgainHref: '/experts/amara',
  },
  files: [],
  notHeld: null,
};

const CLIENT_VIEW: RecapView = {
  ...BASE,
  lens: 'client',
  resolve: {
    engagementId: ENGAGEMENT_ID,
    variant: 'offered',
    requesterLabel: null,
    expertShortName: 'Amara',
    resolved: null,
    reviewWillBeAsked: true,
  },
};

const EXPERT_VIEW: RecapView = {
  ...BASE,
  lens: 'expert',
  party: {
    ...BASE.party,
    name: 'Northwind Industrial',
    headline: null,
    orgLabel: null,
    bookAgainHref: null,
  },
};

function props(over: Record<string, unknown> = {}) {
  return {
    params: Promise.resolve({ meetingId: MEETING_ID }),
    searchParams: Promise.resolve({}),
    ...over,
  };
}

/**
 * Does this text contain an @-SHAPED ADDRESS?
 *
 * ⚠ NO REGEX, DELIBERATELY. Every natural email pattern here (`[\w.%+-]+@[\w.-]+\.\w{2,}`)
 * is super-linear on a crafted input — SonarCloud S5852 / `regexp/no-super-linear-move` — and
 * a security assertion is the last place to ship a ReDoS. This is a single linear pass.
 *
 * ⚠ IT MUST NOT FLAG THE ATTRIBUTION FORM `Amara @ CloudPeak`, which is REQUIRED copy. The
 * distinguishing fact is whitespace: an address has a non-space on BOTH sides of the `@`.
 */
function containsEmailShape(text: string): boolean {
  let at = text.indexOf('@');
  while (at !== -1) {
    const before = at === 0 ? ' ' : text.charAt(at - 1);
    const after = at + 1 >= text.length ? ' ' : text.charAt(at + 1);
    const tight = before.trim().length > 0 && after.trim().length > 0;
    // A real address also has a dot somewhere in the domain half.
    if (
      tight &&
      text
        .slice(at + 1)
        .split(' ')[0]
        ?.includes('.') === true
    ) {
      return true;
    }
    at = text.indexOf('@', at + 1);
  }
  return false;
}

describe('containsEmailShape — the detector the ADR-1044 scan depends on', () => {
  // Every assertion in the leak scan is `.toBe(false)`, so a detector that regressed to
  // always-false would make the whole describe pass silently. These are its positive control.
  it('FLAGS a real address', () => {
    expect(containsEmailShape('amara@cloudpeak.example')).toBe(true);
    expect(containsEmailShape('Reach me at dana.okafor@northwind.co.uk today')).toBe(true);
  });

  it('does NOT flag the REQUIRED attribution form', () => {
    expect(containsEmailShape('Amara @ CloudPeak')).toBe(false);
    expect(containsEmailShape('Accepted by Dana @ Northwind Industrial')).toBe(false);
  });

  it('does not flag a bare @ with no domain dot', () => {
    expect(containsEmailShape('amara@cloudpeak')).toBe(false);
  });
});

describe('RecapPage — access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
    mockLoadRecap.mockResolvedValue(CLIENT_VIEW);
  });

  it('redirects to login when there is no session', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(RecapPage(props())).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mockLoadRecap).not.toHaveBeenCalled();
  });

  it('404s on every gate denial, with no existence oracle', async () => {
    mockLoadRecap.mockResolvedValue(null);
    await expect(RecapPage(props())).rejects.toThrow(/NEXT_NOT_FOUND/);
  });

  it('AWAITS the params promise (Next 16) rather than reading it as an object', async () => {
    await RecapPage(props());
    expect(mockLoadRecap).toHaveBeenCalledWith(MEETING_ID, USER_ID);
  });

  it('re-throws a loader failure so error.tsx renders the boundary', async () => {
    mockLoadRecap.mockRejectedValue(new Error('boom'));
    await expect(RecapPage(props())).rejects.toThrow(/boom/);
  });
});

describe('RecapPage — analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
    mockLoadRecap.mockResolvedValue(CLIENT_VIEW);
  });

  it('fires recap_viewed with the resolve-prompt variant on the client lens', async () => {
    await RecapPage(props());
    expect(mockTrack).toHaveBeenCalledWith('recap_viewed', {
      recap_state: 'ready',
      context_type: 'case',
      lens: 'client',
      source: 'direct',
      resolve_prompt_shown: true,
      resolve_prompt_variant: 'offered',
      distinct_id: USER_ID,
    });
  });

  it('reports variant none on the EXPERT lens — it has no resolve field at all', async () => {
    mockLoadRecap.mockResolvedValue(EXPERT_VIEW);
    await RecapPage(props());
    expect(mockTrack).toHaveBeenCalledWith(
      'recap_viewed',
      expect.objectContaining({
        lens: 'expert',
        resolve_prompt_shown: false,
        resolve_prompt_variant: 'none',
      })
    );
  });

  it('whitelists ?from, collapsing anything unrecognised to direct', async () => {
    await RecapPage(props({ searchParams: Promise.resolve({ from: 'bogus' }) }));
    expect(mockTrack).toHaveBeenCalledWith(
      'recap_viewed',
      expect.objectContaining({ source: 'direct' })
    );

    mockTrack.mockClear();
    await RecapPage(props({ searchParams: Promise.resolve({ from: 'notification' }) }));
    expect(mockTrack).toHaveBeenCalledWith(
      'recap_viewed',
      expect.objectContaining({ source: 'notification' })
    );
  });
});

describe('generateMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
    mockLoadRecap.mockResolvedValue(CLIENT_VIEW);
  });

  it('specialises the title only for an authorised viewer, and never indexes', async () => {
    const meta = await generateMetadata(props());
    expect(meta.title).toBe('Flow interview stuck on a record-triggered loop — Balo');
    expect(meta.robots).toEqual({ index: false, follow: false });
  });

  it('falls back to GENERIC_METADATA when there is no session', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const meta = await generateMetadata(props());
    expect(meta.title).toBe('Meeting recap — Balo');
  });

  it('falls back to GENERIC_METADATA on a gate denial — the title never leaks the subject', async () => {
    mockLoadRecap.mockResolvedValue(null);
    const meta = await generateMetadata(props());
    expect(meta.title).toBe('Meeting recap — Balo');
  });

  it('falls back to GENERIC_METADATA when the loader throws', async () => {
    mockLoadRecap.mockRejectedValue(new Error('boom'));
    const meta = await generateMetadata(props());
    expect(meta.title).toBe('Meeting recap — Balo');
    expect(meta.robots).toEqual({ index: false, follow: false });
  });
});

describe('RecapPage — what actually renders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
  });

  async function renderPage(view: RecapView, over: Record<string, unknown> = {}) {
    mockLoadRecap.mockResolvedValue(view);
    const element = await RecapPage(props(over));
    return render(element);
  }

  it('renders the eyebrow, the title and the status chip', async () => {
    await renderPage(CLIENT_VIEW);
    // Stored in SENTENCE case; the all-caps look is CSS `uppercase` (assistive tech spells
    // short shouted strings out letter by letter).
    expect(screen.getByText('Consultation')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Flow interview stuck on a record-triggered loop/ })
    ).toBeInTheDocument();
    expect(screen.getByText(/Completed/)).toBeInTheDocument();
  });

  it('renders the client-lens wrap-up offer', async () => {
    await renderPage(CLIENT_VIEW);
    expect(screen.getByRole('button', { name: /Mark resolved/ })).toBeInTheDocument();
  });

  it('NEVER renders the resolve prompt on the EXPERT lens', async () => {
    await renderPage(EXPERT_VIEW);
    expect(screen.queryByRole('button', { name: /Mark resolved/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/mark it resolved/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Wrap up/)).not.toBeInTheDocument();
  });

  it('renders the expert-lens banner arm nowhere, even when a request is pending', async () => {
    // A pending request is a CLIENT-lens concept; the expert union arm cannot carry one, and
    // the expert composition does not import the banner at all.
    await renderPage(EXPERT_VIEW);
    expect(screen.queryByText(/thinks this one is sorted/)).not.toBeInTheDocument();
  });

  it("shows the expert's resolution request as the banner, and NOT the rail card", async () => {
    await renderPage({
      ...CLIENT_VIEW,
      resolve: {
        engagementId: ENGAGEMENT_ID,
        variant: 'requested',
        requesterLabel: 'Amara @ CloudPeak',
        expertShortName: 'Amara',
        resolved: null,
        reviewWillBeAsked: true,
      },
    });
    expect(screen.getByText(/Amara @ CloudPeak thinks this one is sorted/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mark resolved/ })).not.toBeInTheDocument();
  });

  it('renders the not-held panel INSTEAD of the artefact sections, with no CTA', async () => {
    const { container } = await renderPage({
      ...CLIENT_VIEW,
      state: 'not_held',
      notHeld: {
        reason: 'no_show_client',
        headline: 'This one did not go ahead',
        body: 'Amara @ CloudPeak joined and waited.',
      },
    });
    expect(screen.getByText(/This one did not go ahead/)).toBeInTheDocument();
    expect(screen.queryByText(/We agreed to rebuild the flow./)).not.toBeInTheDocument();
    // The party card still renders — it carries the page's forward motion.
    expect(container.textContent).toContain('Amara Okafor');
  });

  it("renders Rule M's absent line when no credit session exists", async () => {
    await renderPage(CLIENT_VIEW);
    expect(screen.getByText(/No consultation charge for this one./)).toBeInTheDocument();
  });

  it('renders NO money block at all for a NON-case context', async () => {
    const { container } = await renderPage({
      ...CLIENT_VIEW,
      contextType: 'project_discovery',
      money: null,
      header: { ...CLIENT_VIEW.header, eyebrow: 'DISCOVERY CALL' },
    });
    expect(screen.queryByText(/No consultation charge for this one./)).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('A$');
    expect(container.textContent).not.toContain('Charge pending');
    expect(container.textContent).not.toContain('Payout pending');
  });

  it('renders NO money block for any non-case context, on EITHER lens', async () => {
    for (const contextType of [
      'project_discovery',
      'project_kickoff',
      'package_session',
      'retainer_checkin',
      'request_interaction',
    ] as const) {
      const client = await renderPage({ ...CLIENT_VIEW, contextType, money: null });
      expect(client.container.textContent).not.toContain('A$');
      client.unmount();

      const expert = await renderPage({ ...EXPERT_VIEW, contextType, money: null });
      expect(expert.container.textContent).not.toContain('A$');
      expert.unmount();
    }
  });

  it('renders the ordinal line on the party card', async () => {
    await renderPage(CLIENT_VIEW);
    expect(screen.getByText(/3rd consultation on this case/)).toBeInTheDocument();
  });

  it('omits the Book again CTA entirely when the expert has no username', async () => {
    await renderPage({ ...CLIENT_VIEW, party: { ...CLIENT_VIEW.party, bookAgainHref: null } });
    expect(screen.queryByRole('link', { name: /Book again/ })).not.toBeInTheDocument();
  });

  it('renders no overflow menu — every item in it is dead (D-B)', async () => {
    const { container } = await renderPage(CLIENT_VIEW);
    expect(container.textContent).not.toContain('Download recording');
    expect(container.textContent).not.toContain('Copy transcript link');
    expect(container.textContent).not.toContain('Export summary');
  });

  it('renders no recording affordance anywhere (D-B)', async () => {
    const { container } = await renderPage(CLIENT_VIEW);
    expect(container.textContent).not.toMatch(/recording/i);
  });
});

describe('RecapPage — NO COUNTERPARTY EMAIL, ANYWHERE (ADR-1044)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
  });

  /**
   * ⚠ THIS IS THE LOAD-BEARING CONCEALMENT ASSERTION. It scans the WHOLE rendered document —
   * text AND markup, so a `mailto:`, a `title` attribute or a gravatar-style hashed avatar URL
   * is caught as readily as visible copy. The fixtures deliberately try to leak: the party
   * card, the not-held body, the resolve banner and the file uploader label are the four
   * places a counterparty name is rendered, and every one of them must render a NAME only.
   */
  async function renderAndScan(view: RecapView): Promise<{ text: string; html: string }> {
    mockLoadRecap.mockResolvedValue(view);
    const element = await RecapPage(props());
    const { container } = render(element);
    return { text: container.textContent ?? '', html: container.innerHTML };
  }

  const LEAKY_FILES = [
    {
      file: {
        id: 'f1',
        meetingId: MEETING_ID,
        fileName: 'migration-plan.pdf',
        contentType: 'application/pdf',
        sizeBytes: 2048,
        party: 'expert' as const,
        source: 'files_tab' as const,
        uploadedByUserId: 'u-expert',
        createdAtIso: '2026-07-29T05:00:00.000Z',
      },
      uploaderLabel: 'Amara',
    },
  ];

  const CASES: ReadonlyArray<readonly [string, RecapView]> = [
    ['client / ready', { ...CLIENT_VIEW, files: LEAKY_FILES }],
    ['expert / ready', { ...EXPERT_VIEW, files: LEAKY_FILES }],
    [
      'client / requested banner',
      {
        ...CLIENT_VIEW,
        files: LEAKY_FILES,
        resolve: {
          engagementId: ENGAGEMENT_ID,
          variant: 'requested' as const,
          requesterLabel: 'Amara @ CloudPeak',
          expertShortName: 'Amara',
          resolved: null,
          reviewWillBeAsked: true,
        },
      },
    ],
    [
      'client / not held',
      {
        ...CLIENT_VIEW,
        state: 'not_held' as const,
        files: LEAKY_FILES,
        notHeld: {
          reason: 'no_show_client' as const,
          headline: 'This one did not go ahead',
          body: 'Amara @ CloudPeak joined and waited.',
        },
      },
    ],
    [
      'expert / not held',
      {
        ...EXPERT_VIEW,
        state: 'not_held' as const,
        files: LEAKY_FILES,
        notHeld: {
          reason: 'missed_call' as const,
          headline: 'This one did not go ahead',
          body: 'The call did not start.',
        },
      },
    ],
    [
      'client / artefacts absent',
      {
        ...CLIENT_VIEW,
        state: 'artifacts_absent' as const,
        files: LEAKY_FILES,
        artifacts: {
          summary: { state: 'absent' as const, content: null },
          transcript: { state: 'absent' as const, content: null },
          collapsed: true,
        },
      },
    ],
  ];

  it.each(CASES)('emits no @-shaped address and no mailto: — %s', async (_label, view) => {
    const { text, html } = await renderAndScan(view);
    expect(containsEmailShape(text)).toBe(false);
    expect(containsEmailShape(html)).toBe(false);
    expect(html).not.toContain('mailto:');
  });

  it('renders the counterparty as a NAME, so the scan is not passing vacuously', async () => {
    const { text } = await renderAndScan({ ...CLIENT_VIEW, files: LEAKY_FILES });
    expect(text).toContain('Amara Okafor');
    expect(text).toContain('CloudPeak');
  });

  it('renders no r2 object key for any file', async () => {
    const { html } = await renderAndScan({ ...CLIENT_VIEW, files: LEAKY_FILES });
    expect(html).not.toContain('meeting-files/');
    expect(html).not.toContain('r2Key');
  });
});
