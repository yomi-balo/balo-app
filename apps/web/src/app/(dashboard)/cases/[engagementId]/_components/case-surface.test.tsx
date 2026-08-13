import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { CaseSurfaceView } from '@/lib/cases/case-view-types';

/**
 * BAL-421 — the desktop composition, tested for the ONE thing composition can get wrong: which
 * lens is offered which lifecycle action.
 *
 * ⚠⚠ "MARK RESOLVED" IS CLIENT-ONLY (BAL-417), AND THE EXPERT MAY ONLY *ASK*. The asymmetry is
 * enforced three times over — the `CaseSurfaceView` DISCRIMINANT (an expert-lens view has no
 * `canClose` field at all), `resolveCaseAction`'s lens assertion, and
 * `caseEngagementsRepository.close()`'s live-membership invariant. This file pins the FIRST of
 * those at the render layer: the assertions below scan the WHOLE tree for the affordance rather
 * than checking one branch, so a future refactor that reintroduced a lens-blind `&&` would fail
 * here even if it read the flag from somewhere else.
 */

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';
const VIEWER_ID = 'u0000000-0000-4000-8000-000000000002';

vi.mock('server-only', () => ({}));

vi.mock('motion/react', () => ({
  motion: {
    div: (props: Record<string, unknown>) => (
      <div className={props.className as string}>{props.children as React.ReactNode}</div>
    ),
  },
  useReducedMotion: () => true,
  AnimatePresence: (props: Record<string, unknown>) => <>{props.children as React.ReactNode}</>,
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock('@/components/balo/conversation/use-conversation-realtime', () => ({
  useConversationRealtime: vi.fn(),
}));

vi.mock('../_actions/resolve-case', () => ({ resolveCaseAction: vi.fn() }));
vi.mock('../_actions/request-resolution', () => ({ requestResolutionAction: vi.fn() }));
vi.mock('../_actions/dismiss-resolution-request', () => ({
  dismissResolutionRequestAction: vi.fn(),
}));
vi.mock('../_actions/create-case-realtime-token', () => ({
  createCaseRealtimeTokenAction: vi.fn(),
}));
vi.mock('../_actions/fetch-case-thread', () => ({ fetchCaseThreadAction: vi.fn() }));
vi.mock('../_actions/post-case-message', () => ({ postCaseMessageAction: vi.fn() }));
vi.mock('../_actions/mark-case-thread-read', () => ({
  markCaseThreadReadAction: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('../_actions/request-case-file-upload', () => ({ requestCaseFileUploadAction: vi.fn() }));
vi.mock('../_actions/confirm-case-file-upload', () => ({ confirmCaseFileUploadAction: vi.fn() }));
vi.mock('../_actions/get-case-file-download', () => ({ getCaseFileDownloadAction: vi.fn() }));

import { CaseSurface } from './case-surface';

const BASE = {
  engagementId: ENGAGEMENT_ID,
  viewerUserId: VIEWER_ID,
  header: {
    title: 'Flow interview loop',
    descriptionHtml: '<p>We need to rebuild the intake flow.</p>',
    openedAtIso: '2026-06-12T09:00:00Z',
    heldConsultationCount: 2,
    consultationCount: 3,
    isOpen: true,
    closeReason: null,
    closedAtIso: null,
    counterpartyOrgLabel: 'CloudPeak',
    closedNote: null,
  },
  nudge: null,
  consultations: [],
  conversation: {
    conversationId: 'v-1',
    writable: true,
    counterpartyFirstName: 'Amara',
    counterpartyName: 'Amara Okafor',
    initialMessages: [],
    initialHasEarlier: false,
    initialFiles: [],
    realtimeEnabled: false,
  },
  actionItems: {
    yours: [],
    theirs: [],
    unassigned: [],
    counterpartyLabel: 'Amara',
    doneCount: 0,
    totalCount: 0,
  },
  files: [],
  filesTruncated: false,
  party: {
    name: 'Amara Okafor',
    headline: 'Salesforce architect',
    orgLabel: 'CloudPeak',
    avatarUrl: null,
    initials: 'AO',
    bookAgainHref: '/experts/amara-okafor',
  },
  people: [
    { name: 'Dana Reyes', isViewer: true },
    { name: 'Amara Okafor', isViewer: false },
  ],
} satisfies Omit<CaseSurfaceView, 'lens' | 'canClose'>;

function clientView(over: Partial<CaseSurfaceView> = {}): CaseSurfaceView {
  return { ...BASE, lens: 'client', canClose: true, ...over } as CaseSurfaceView;
}

function expertView(over: Record<string, unknown> = {}): CaseSurfaceView {
  return {
    ...BASE,
    lens: 'expert',
    earnings: { state: 'not_yet', earningsAudMinor: null, finalizedCount: 0, pendingCount: 0 },
    canRequestResolution: true,
    ...over,
  } as CaseSurfaceView;
}

const MARK_RESOLVED = /mark resolved/i;
const ASK_RESOLVED = /ask if it's resolved/i;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CaseSurface — the EXPERT lens NEVER renders "Mark resolved"', () => {
  it('offers the expert the ASK, and no close affordance anywhere in the tree', () => {
    const { container } = render(<CaseSurface view={expertView()} />);
    expect(screen.getByRole('button', { name: ASK_RESOLVED })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: MARK_RESOLVED })).not.toBeInTheDocument();
    // Belt and braces: the string does not appear at all, in any node or aria-label.
    expect(container.textContent ?? '').not.toMatch(MARK_RESOLVED);
  });

  it('renders NO close affordance for the expert even when the ask is unavailable', () => {
    // The one state where the expert's own rail action is absent — the close must not appear
    // to fill the gap.
    const { container } = render(
      <CaseSurface view={expertView({ canRequestResolution: false })} />
    );
    expect(screen.queryByRole('button', { name: ASK_RESOLVED })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: MARK_RESOLVED })).not.toBeInTheDocument();
    expect(container.textContent ?? '').not.toMatch(MARK_RESOLVED);
  });

  it('renders NO close affordance for the expert on a CLOSED case', () => {
    const view = expertView({
      header: { ...BASE.header, isOpen: false, closeReason: 'resolved' },
      canRequestResolution: false,
    });
    const { container } = render(<CaseSurface view={view} />);
    expect(container.textContent ?? '').not.toMatch(MARK_RESOLVED);
  });
});

describe('CaseSurface — the CLIENT lens gets the close, and never the ask', () => {
  it('renders "Mark resolved" and NO "Ask if it\'s resolved"', () => {
    render(<CaseSurface view={clientView()} />);
    expect(screen.getByRole('button', { name: MARK_RESOLVED })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ASK_RESOLVED })).not.toBeInTheDocument();
  });

  /**
   * ⚠ BOTH FLAGS ARE FALSE ON A CLOSED CASE, so a resolved case offers NEITHER — and neither
   * is ever rendered DISABLED. An absent action beats a dead one.
   */
  it('renders NEITHER lifecycle action on a closed case', () => {
    const view = clientView({
      canClose: false,
      header: { ...BASE.header, isOpen: false, closeReason: 'resolved' },
    });
    render(<CaseSurface view={view} />);
    expect(screen.queryByRole('button', { name: MARK_RESOLVED })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ASK_RESOLVED })).not.toBeInTheDocument();
  });

  it('never renders a DISABLED lifecycle button as a substitute for an absent one', () => {
    render(<CaseSurface view={clientView({ canClose: false })} />);
    const disabled = screen
      .queryAllByRole('button')
      .filter((button) => button.hasAttribute('disabled'));
    expect(disabled.map((button) => button.textContent ?? '').join(' ')).not.toMatch(MARK_RESOLVED);
  });
});

/**
 * ⚠⚠ FEE CONCEALMENT, AT THE RENDER LAYER. The earnings block is not conditionally HIDDEN on
 * the client arm — a client-lens view has no `earnings` FIELD to pass — so the invariant is
 * structural. This asserts the consequence: no money vocabulary reaches a client's DOM.
 */
describe('CaseSurface — the lens is a discriminant all the way down', () => {
  it('renders the earnings block ONLY on the expert arm', () => {
    const { unmount } = render(<CaseSurface view={expertView()} />);
    expect(screen.getByText('Earned on this case')).toBeInTheDocument();
    unmount();

    render(<CaseSurface view={clientView()} />);
    expect(screen.queryByText('Earned on this case')).not.toBeInTheDocument();
  });

  it('shows a CLIENT no earnings, no A$ figure and no margin vocabulary anywhere', () => {
    const { container } = render(<CaseSurface view={clientView()} />);
    const text = (container.textContent ?? '').toLowerCase();
    expect(container.textContent ?? '').not.toContain('A$');
    for (const word of ['earned', 'earnings', 'margin', 'markup', 'payout']) {
      expect(text).not.toContain(word);
    }
  });

  it('shows the EXPERT no A$ figure either while earnings are `not_yet`', () => {
    // Every case on `main` is in this state today — a figure here would be a money claim.
    const { container } = render(<CaseSurface view={expertView()} />);
    expect(container.textContent ?? '').not.toContain('A$');
  });

  it('renders the header and people for both lenses', () => {
    const { unmount } = render(<CaseSurface view={clientView()} />);
    expect(screen.getByRole('heading', { name: 'Flow interview loop' })).toBeInTheDocument();
    // "You" is resolved SERVER-SIDE via `isViewer`; the client never compares ids. The viewer's
    // own name must therefore NOT be rendered in the people list.
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.queryByText('Dana Reyes')).not.toBeInTheDocument();
    unmount();

    render(<CaseSurface view={expertView()} />);
    expect(screen.getByRole('heading', { name: 'Flow interview loop' })).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
  });
});
