import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@/test/utils';
import type { RecapResolveView, RecapView } from '@/lib/meetings/recap-view-types';
import type { ActionItemsPanelView } from '@/lib/engagement/action-items-view';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';

vi.mock('server-only', () => ({}));

// Motion misbehaves under JSDOM; the entrance animation is not what any assertion here is
// about. The mock KEEPS `className`, which two of these tests read.
vi.mock('motion/react', () => ({
  motion: {
    div: (props: Record<string, unknown>) => (
      <div className={props.className as string}>{props.children as React.ReactNode}</div>
    ),
  },
  useReducedMotion: () => true,
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('../_actions/resolve-case', () => ({ resolveCaseAction: vi.fn() }));
vi.mock('../_actions/dismiss-resolution-request', () => ({
  dismissResolutionRequestAction: vi.fn(),
}));
vi.mock('../_actions/get-meeting-file-download', () => ({
  getMeetingFileDownloadAction: vi.fn(),
}));
vi.mock('../_actions/get-meeting-recording-playback', () => ({
  getMeetingRecordingPlaybackAction: vi.fn(),
}));
// The action-items panel is a client island that imports the delivery-workspace Server
// Actions; the compositions below never click them.
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/create-action-item', () => ({
  createActionItemAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/update-action-item', () => ({
  updateActionItemAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/assign-action-item', () => ({
  assignActionItemAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/set-action-item-status', () => ({
  setActionItemStatusAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/remove-action-item', () => ({
  removeActionItemAction: vi.fn(),
}));

import { dismissResolutionRequestAction } from '../_actions/dismiss-resolution-request';
import { RecapLayout } from './recap-layout';
import { ResolveDismissalProvider } from './resolve-dismissal';
import { ResolvePromptBanner } from './resolve-prompt-banner';
import { WrapUpCard } from './wrap-up-card';

const READY_ARTIFACTS = {
  summary: { state: 'ready' as const, content: 'We agreed to rebuild the flow.' },
  transcript: { state: 'ready' as const, content: 'Amara: hello there.' },
  collapsed: false,
};

const COLLAPSED_ARTIFACTS = {
  summary: { state: 'absent' as const, content: null },
  transcript: { state: 'absent' as const, content: null },
  collapsed: true,
};

const VIEW: RecapView = {
  meetingId: MEETING_ID,
  contextType: 'case',
  state: 'ready',
  header: {
    eyebrow: 'Consultation',
    caseHref: null,
    title: 'Flow interview stuck on a loop',
    status: { label: 'Completed', tone: 'success', icon: 'check' },
    closedNote: null,
    occurredAtIso: '2026-07-29T04:14:00.000Z',
    durationMinutes: 45,
    openActionItemCount: 0,
    totalActionItemCount: 0,
  },
  money: { kind: 'absent' },
  artifacts: READY_ARTIFACTS,
  actionItems: null,
  party: {
    name: 'Amara Okafor',
    headline: null,
    orgLabel: null,
    avatarUrl: null,
    initials: 'AO',
    ordinalLine: null,
    bookAgainHref: null,
    // Expert lens (below) — nothing evaluative on the client company.
    ratingAverage: null,
    ratingCount: 0,
  },
  files: [],
  recordings: [],
  notHeld: null,
  lens: 'expert',
};

/** A read-only, ITEM-LESS panel view — what EVERY case recap carries today (canWrite is false). */
const EMPTY_ACTION_ITEMS: ActionItemsPanelView = {
  engagementId: 'e1',
  items: [],
  canWrite: false,
  viewerParty: 'client',
  clientCompanyName: 'Northwind Industrial',
  expertPartyShort: 'CloudPeak',
};

const ONE_ACTION_ITEM: ActionItemsPanelView = {
  ...EMPTY_ACTION_ITEMS,
  items: [
    {
      id: 'ai-1',
      body: 'Send the migration plan',
      status: 'open',
      assigneeParty: null,
      assigneeLabel: null,
      dueLabel: null,
      dueAtValue: null,
      isOverdue: false,
    },
  ],
};

const OFFERED: RecapResolveView = {
  engagementId: 'e1',
  variant: 'offered',
  requesterLabel: null,
  expertShortName: 'Amara',
  resolved: null,
  reviewWillBeAsked: true,
};

const REQUESTED: RecapResolveView = {
  ...OFFERED,
  variant: 'requested',
  requesterLabel: 'Amara @ CloudPeak',
};

/** The CLIENT arm of the union — the only lens that carries `resolve`. */
const CLIENT_VIEW: RecapView = { ...VIEW, lens: 'client', resolve: OFFERED };

/** The heading/label text of each region, in the order the DOM actually emits it. */
function regionOrder(container: HTMLElement): string[] {
  const wanted = ['Summary', 'Transcript', 'Files'];
  return [...container.querySelectorAll('section')]
    .map((node) => wanted.find((label) => node.textContent?.includes(label) === true))
    .filter((label): label is string => label !== undefined);
}

describe('RecapLayout — the artefact COLLAPSE rule is composed, not just computed', () => {
  it('renders ONE absence card, not two, when both artefacts are missing', () => {
    render(<RecapLayout view={{ ...VIEW, artifacts: COLLAPSED_ARTIFACTS }} />);

    // The collapsed Summary card already says "No summary or transcript for this one"; a
    // Transcript card beneath it saying "No transcript for this one" is the second, contradictory
    // absence statement the rule exists to prevent - and it is the COMMON case today.
    expect(screen.getByText(/No summary or transcript for this one/)).toBeInTheDocument();
    expect(screen.queryByText('Transcript')).not.toBeInTheDocument();
    expect(screen.queryByText(/No transcript for this one/)).not.toBeInTheDocument();
  });

  it('renders the transcript when it is NOT collapsed', () => {
    render(<RecapLayout view={VIEW} />);
    expect(screen.getByText('Transcript')).toBeInTheDocument();
  });

  it('renders the transcript when the summary is absent but the transcript is ready', () => {
    render(
      <RecapLayout
        view={{
          ...VIEW,
          artifacts: {
            summary: { state: 'absent', content: null },
            transcript: { state: 'ready', content: 'Amara: hello.' },
            collapsed: false,
          },
        }}
      />
    );
    expect(screen.getByText('Transcript')).toBeInTheDocument();
  });

  it('renders NO artefact sections at all when the meeting was not held', () => {
    render(
      <RecapLayout
        view={{
          ...VIEW,
          artifacts: COLLAPSED_ARTIFACTS,
          notHeld: { reason: 'cancelled', headline: 'This one did not go ahead', body: 'b' },
        }}
      />
    );
    expect(screen.queryByText('Summary')).not.toBeInTheDocument();
    expect(screen.queryByText('Transcript')).not.toBeInTheDocument();
  });
});

describe('RecapLayout — the mobile order rule actually resolves', () => {
  it('emits the DESKTOP sequence in the DOM', () => {
    const { container } = render(<RecapLayout view={VIEW} />);
    expect(regionOrder(container)).toEqual(['Summary', 'Transcript', 'Files']);
  });

  it('makes the transcript a REAL grid child, which is what makes order-last resolve', () => {
    const { container } = render(<RecapLayout view={VIEW} />);

    const transcriptWrapper = [...container.querySelectorAll('div')].find(
      (node) => node.className.includes('order-last') === true
    );
    expect(transcriptWrapper).toBeDefined();
    expect(transcriptWrapper?.textContent).toContain('Transcript');

    // THE BUG THIS PINS: `order` only resolves between SIBLING grid items. With the column
    // wrapper left as a flex container, `order-last` was scoped to the main column - where the
    // transcript is ALREADY last - so it was a no-op and the longest region sat between the
    // action items and the only forward action at 375px. `contents` dissolves the wrapper
    // below `lg` so the transcript becomes a genuine child of the grid.
    const columnWrapper = transcriptWrapper?.parentElement;
    expect(columnWrapper?.className).toContain('contents');
    expect(columnWrapper?.parentElement?.className).toContain('grid');
  });

  it('dissolves the RAIL wrapper too, so the rail cards join the same order ladder', () => {
    const { container } = render(<RecapLayout view={VIEW} />);
    const wrappers = [...container.querySelectorAll('div.contents')];
    expect(wrappers).toHaveLength(2);
    for (const wrapper of wrappers) {
      expect(wrapper.className).toContain('lg:flex');
    }
  });

  it('restores the desktop layout above lg (every order class is lg-reset)', () => {
    const { container } = render(<RecapLayout view={VIEW} />);
    const ordered = [...container.querySelectorAll('div')].filter((node) =>
      / order-|^order-/.test(node.className)
    );
    expect(ordered.length).toBeGreaterThanOrEqual(3);
    for (const node of ordered) {
      expect(node.className).toContain('lg:order-none');
    }
  });
});

describe('RecapLayout — the slots', () => {
  it('renders NO empty Reveal wrapper when a slot is undefined', () => {
    const { container } = render(<RecapLayout view={VIEW} />);
    // A component that returns `null` still leaves its wrapper behind as an EFFECTIVE GRID
    // CHILD, i.e. a dead 16-24px gap above the grid and another between the party card and
    // Files - including immediately after resolving. The slots are passed as `undefined`.
    const gridChildren = [...container.querySelectorAll('div.contents')].flatMap((wrapper) => [
      ...wrapper.children,
    ]);
    expect(gridChildren.length).toBeGreaterThan(0);
    for (const child of gridChildren) {
      expect((child.textContent ?? '').trim()).not.toBe('');
    }
    // The banner slot sits ABOVE the grid; when it is undefined its wrapper must not exist.
    expect(container.querySelector('.mt-4.block')).toBeNull();
  });

  it('mounts both slots when they are provided', () => {
    render(<RecapLayout view={VIEW} banner={<p>BANNER SLOT</p>} wrapUp={<p>WRAP UP SLOT</p>} />);
    expect(screen.getByText('BANNER SLOT')).toBeInTheDocument();
    expect(screen.getByText('WRAP UP SLOT')).toBeInTheDocument();
  });
});

describe('RecapLayout — the ZERO-ACTION-ITEM composition', () => {
  it('renders NO action-items region, and no empty wrapper, for a read-only EMPTY list', () => {
    const { container } = render(
      <RecapLayout view={{ ...VIEW, actionItems: EMPTY_ACTION_ITEMS }} />
    );

    // `ActionItemsPanel` returns null for a read-only, item-less list, and EVERY recap is
    // read-only today - so this is the UNIVERSAL case, not an edge one. A `Reveal` around a
    // null child is still a grid CHILD: a dead 16-24px gap between the summary and the
    // transcript, on every meeting that captured no action items.
    expect(screen.queryByText('Action items')).not.toBeInTheDocument();
    const gridChildren = [...container.querySelectorAll('div.contents')].flatMap((wrapper) => [
      ...wrapper.children,
    ]);
    expect(gridChildren.length).toBeGreaterThan(0);
    for (const child of gridChildren) {
      expect((child.textContent ?? '').trim()).not.toBe('');
    }
    // …and the ladder still reads Summary -> Transcript -> Files with nothing between.
    expect(regionOrder(container)).toEqual(['Summary', 'Transcript', 'Files']);
  });

  it('DOES render the region as soon as the list has an item', () => {
    render(<RecapLayout view={{ ...VIEW, actionItems: ONE_ACTION_ITEM }} />);
    expect(screen.getByText('Action items')).toBeInTheDocument();
    expect(screen.getByText('Send the migration plan')).toBeInTheDocument();
  });

  it('keeps the region for a WRITABLE empty list — that one invites an add', () => {
    render(
      <RecapLayout view={{ ...VIEW, actionItems: { ...EMPTY_ACTION_ITEMS, canWrite: true } }} />
    );
    expect(screen.getByText('Action items')).toBeInTheDocument();
  });
});

describe('RecapLayout — the resolve question is asked EXACTLY ONCE per session', () => {
  it('does not surface the R9 wrap-up when the R4 banner was just dismissed', async () => {
    vi.mocked(dismissResolutionRequestAction).mockResolvedValue({ success: true });
    const user = userEvent.setup();

    const { rerender } = render(
      <ResolveDismissalProvider>
        <RecapLayout
          view={{ ...CLIENT_VIEW, resolve: REQUESTED }}
          banner={<ResolvePromptBanner meetingId={MEETING_ID} resolve={REQUESTED} />}
        />
      </ResolveDismissalProvider>
    );
    expect(screen.getByText(/thinks this one is sorted/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Not yet/ }));
    await waitFor(() => expect(dismissResolutionRequestAction).toHaveBeenCalled());

    // THE BUG THIS PINS: the dismissal CLEARS the paired request columns server-side, so the
    // refresh it triggers legitimately re-renders with `variant: 'offered'` - and the client
    // composition then fills the R9 slot. Re-render exactly that payload: `router.refresh()`
    // reconciles the SAME provider instance, so the "not yet" answer has to survive it.
    rerender(
      <ResolveDismissalProvider>
        <RecapLayout
          view={CLIENT_VIEW}
          wrapUp={<WrapUpCard meetingId={MEETING_ID} resolve={OFFERED} />}
        />
      </ResolveDismissalProvider>
    );

    expect(screen.queryByText('Wrap up')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mark resolved/ })).not.toBeInTheDocument();
    // And no empty wrapper is left where the card would have been.
    expect(screen.queryByText(/thinks this one is sorted/)).not.toBeInTheDocument();
  });

  it('DOES surface the wrap-up card when nothing was dismissed', () => {
    render(
      <ResolveDismissalProvider>
        <RecapLayout
          view={CLIENT_VIEW}
          wrapUp={<WrapUpCard meetingId={MEETING_ID} resolve={OFFERED} />}
        />
      </ResolveDismissalProvider>
    );
    expect(screen.getByRole('button', { name: /Mark resolved/ })).toBeInTheDocument();
  });

  it('renders both slots with NO provider at all — the expert lens and every isolated test', () => {
    render(<RecapLayout view={VIEW} banner={<p>BANNER SLOT</p>} wrapUp={<p>WRAP UP SLOT</p>} />);
    expect(screen.getByText('BANNER SLOT')).toBeInTheDocument();
    expect(screen.getByText('WRAP UP SLOT')).toBeInTheDocument();
  });
});
