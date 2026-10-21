import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { act, fireEvent, render, screen, waitFor, within } from '@/test/utils';
import { axe } from '@/test/axe';
import { track, DASHBOARD_EVENTS } from '@/lib/analytics';
import { useIsMobile } from '@/hooks/use-mobile';
import { PARTICIPANT_STAGES, TURN_EXPLANATIONS } from '@/lib/projects-inbox/project-stages';
import {
  PROJECT_TRACK_COPY,
  type ProjectTrackStage,
  type ProjectTrackToken,
  type ProjectTrackView,
} from '../_lib/your-move-view-types';
import { ProjectTrack } from './project-track';

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: vi.fn() }));
const useIsMobileMock = vi.mocked(useIsMobile);

function token(id: string, over: Partial<ProjectTrackToken> = {}): ProjectTrackToken {
  return {
    id,
    label: `Label ${id}`,
    title: `Title ${id}`,
    href: `/projects/${id}`,
    turn: 'waiting',
    ...over,
  };
}

function stage(
  key: ProjectTrackStage['key'],
  label: string,
  tokens: ProjectTrackToken[] = [],
  lens: 'expert' | 'client' = 'expert'
): ProjectTrackStage {
  const explanation = PARTICIPANT_STAGES[lens].find((s) => s.key === key)?.explanation ?? '';
  return {
    key,
    label,
    explanation,
    tokens,
    hasYourMove: tokens.some((t) => t.turn === 'your_move'),
  };
}

const EXPERT_VIEW: ProjectTrackView = {
  workspaceType: 'expert',
  stages: [
    stage('invited', 'Invited', [token('a', { turn: 'your_move' })]),
    stage('eoi', 'Interest sent'),
    stage('proposal', 'Proposal', [token('b'), token('c')]),
    stage('kickoff', 'Kickoff'),
    stage('delivery', 'Delivery', [token('d', { turn: 'in_progress' })]),
  ],
};

const COMPANY_VIEW: ProjectTrackView = {
  workspaceType: 'company',
  stages: [
    stage('matching', 'Matching', [token('m', { label: 'Same', title: 'Same' })], 'client'),
    stage('interest', 'Interest', [], 'client'),
    stage('proposal', 'Proposals', [], 'client'),
    stage('kickoff', 'Kickoff', [], 'client'),
    stage('delivery', 'Delivery', [], 'client'),
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  useIsMobileMock.mockReturnValue(false);
});

describe('ProjectTrack', () => {
  it('renders the title, sub and legend for the lens', () => {
    render(<ProjectTrack view={EXPERT_VIEW} />);
    expect(
      screen.getByRole('heading', { name: PROJECT_TRACK_COPY.expert.title })
    ).toBeInTheDocument();
    expect(screen.getByText(PROJECT_TRACK_COPY.expert.sub)).toBeInTheDocument();
    const legend = within(screen.getByRole('list', { name: 'Legend' }));
    expect(legend.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Your move',
      'Waiting on client',
      'In progress',
    ]);
  });

  it('uses the company waiting copy on the company lens', () => {
    render(<ProjectTrack view={COMPANY_VIEW} />);
    expect(screen.getByText('Waiting on others')).toBeInTheDocument();
  });

  it('renders every stage label with its count, and None for an empty stage', () => {
    render(<ProjectTrack view={EXPERT_VIEW} />);
    for (const label of ['Invited', 'Interest sent', 'Proposal', 'Kickoff', 'Delivery']) {
      expect(screen.getByText(label, { exact: false })).toBeInTheDocument();
    }
    expect(screen.getByText(', 2 projects')).toBeInTheDocument();
    expect(screen.getAllByText(', 1 project')).toHaveLength(2);
    expect(screen.getAllByText('None')).toHaveLength(2);
  });

  it('tones each stage node: filled for your move, dashed when empty, open otherwise', () => {
    const { container } = render(<ProjectTrack view={EXPERT_VIEW} />);
    const tones = [...container.querySelectorAll('[data-tone]')].map((n) =>
      n.getAttribute('data-tone')
    );
    expect(tones).toEqual(['filled', 'empty', 'open', 'empty', 'open']);
  });

  it('links each token to its href with an accessible name that carries whose move it is', () => {
    render(<ProjectTrack view={EXPERT_VIEW} />);
    const mine = screen.getByRole('link', { name: 'Label a, Title a: your move' });
    expect(mine).toHaveAttribute('href', '/projects/a');
    expect(mine).toHaveAttribute('data-turn', 'your_move');
    expect(
      screen.getByRole('link', { name: 'Label b, Title b: waiting on client' })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Label d, Title d: in progress' })).toBeInTheDocument();
  });

  it('does not double the name when the label equals the title', () => {
    render(<ProjectTrack view={COMPANY_VIEW} />);
    expect(screen.getByRole('link', { name: 'Same: waiting on others' })).toBeInTheDocument();
  });

  it('tracks a click with workspace, stage and turn only, and leaves navigation alone', async () => {
    const user = userEvent.setup();
    render(<ProjectTrack view={EXPERT_VIEW} />);
    await user.click(screen.getByRole('link', { name: 'Label b, Title b: waiting on client' }));
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(DASHBOARD_EVENTS.TRACK_CLICKED, {
      workspace_type: 'expert',
      stage: 'proposal',
      turn: 'waiting',
    });
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<ProjectTrack view={EXPERT_VIEW} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('desktop stage and legend explanations', () => {
  const STAGES = EXPERT_VIEW.stages;

  it('opens a popover with the term and its sentence for every stage and legend item', async () => {
    const user = userEvent.setup();
    for (const view of [EXPERT_VIEW, COMPANY_VIEW]) {
      const lens = view.workspaceType === 'expert' ? 'expert' : 'client';
      const { unmount } = render(<ProjectTrack view={view} />);
      for (const s of view.stages) {
        await user.click(screen.getByRole('button', { name: s.label }));
        const dialog = await screen.findByRole('dialog', { name: s.label });
        expect(within(dialog).getByText(s.explanation)).toBeInTheDocument();
        await user.keyboard('{Escape}');
      }
      for (const [turn, label] of [
        ['your_move', 'Your move'],
        ['waiting', PROJECT_TRACK_COPY[view.workspaceType].waiting],
        ['in_progress', 'In progress'],
      ] as const) {
        await user.click(screen.getByRole('button', { name: label }));
        const dialog = await screen.findByRole('dialog', { name: label });
        expect(within(dialog).getByText(TURN_EXPLANATIONS[lens][turn])).toBeInTheDocument();
        await user.keyboard('{Escape}');
      }
      unmount();
    }
  });

  it('opens with Enter and Space', async () => {
    const user = userEvent.setup();
    render(<ProjectTrack view={EXPERT_VIEW} />);
    screen.getByRole('button', { name: 'Proposal' }).focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Proposal' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.keyboard(' ');
    expect(await screen.findByRole('dialog', { name: 'Proposal' })).toBeInTheDocument();
  });

  it('toggles closed on a second click', async () => {
    const user = userEvent.setup();
    render(<ProjectTrack view={EXPERT_VIEW} />);
    const trigger = screen.getByRole('button', { name: 'Invited' });
    await user.click(trigger);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.click(trigger);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on an outside pointerdown with no focus change, and on Tab away', async () => {
    const user = userEvent.setup();
    render(<ProjectTrack view={EXPERT_VIEW} />);
    await user.click(screen.getByRole('button', { name: 'Invited' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Invited' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.tab();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  describe('hover boundary', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('opens a mouse hover after 300ms and not before it, and closes on leave', () => {
      render(<ProjectTrack view={EXPERT_VIEW} />);
      const trigger = screen.getByRole('button', { name: 'Kickoff' });
      fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
      act(() => {
        vi.advanceTimersByTime(299);
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByRole('dialog', { name: 'Kickoff' })).toBeInTheDocument();
      expect(track).toHaveBeenCalledTimes(1);
      expect(track).toHaveBeenCalledWith(DASHBOARD_EVENTS.TRACK_TERM_OPENED, {
        workspace_type: 'expert',
        target: 'stage',
        key: 'kickoff',
        via: 'hover',
      });
      fireEvent.pointerLeave(trigger, { pointerType: 'mouse' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  describe('hover', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not open when the pointer leaves before the delay', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<ProjectTrack view={EXPERT_VIEW} />);
      const trigger = screen.getByRole('button', { name: 'Kickoff' });
      await user.hover(trigger);
      await user.unhover(trigger);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('keeps a hover-opened popover open when clicked, even after the pointer leaves', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<ProjectTrack view={EXPERT_VIEW} />);
      const trigger = screen.getByRole('button', { name: 'Kickoff' });
      await user.hover(trigger);
      act(() => {
        vi.advanceTimersByTime(310);
      });
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      expect(track).toHaveBeenCalledTimes(1);
      await user.click(trigger);
      await user.unhover(trigger);
      expect(screen.getByRole('dialog', { name: 'Kickoff' })).toBeInTheDocument();
      expect(track).toHaveBeenCalledTimes(1);
    });
  });

  it('tracks each open once with workspace, target, key and via only', async () => {
    const user = userEvent.setup();
    render(<ProjectTrack view={EXPERT_VIEW} />);
    await user.click(screen.getByRole('button', { name: 'Interest sent' }));
    await user.click(screen.getByRole('button', { name: 'Your move' }));
    expect(track).toHaveBeenCalledTimes(2);
    expect(track).toHaveBeenNthCalledWith(1, DASHBOARD_EVENTS.TRACK_TERM_OPENED, {
      workspace_type: 'expert',
      target: 'stage',
      key: 'eoi',
      via: 'click',
    });
    expect(track).toHaveBeenNthCalledWith(2, DASHBOARD_EVENTS.TRACK_TERM_OPENED, {
      workspace_type: 'expert',
      target: 'legend',
      key: 'your_move',
      via: 'click',
    });
  });

  it('names the trigger by the stage, keeps the sr-only count, and sits outside any link', () => {
    render(<ProjectTrack view={EXPERT_VIEW} />);
    for (const s of STAGES) {
      const trigger = screen.getByRole('button', { name: s.label });
      expect(trigger.closest('a')).toBeNull();
    }
    expect(screen.getByText(', 2 projects')).toBeInTheDocument();
  });

  it('has no accessibility violations with a popover open, on both lenses', async () => {
    const user = userEvent.setup();
    for (const view of [EXPERT_VIEW, COMPANY_VIEW]) {
      const { container, unmount } = render(<ProjectTrack view={view} />);
      await user.click(screen.getByRole('button', { name: view.stages[0]?.label ?? '' }));
      await screen.findByRole('dialog');
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});

describe('mobile stage and legend explanations', () => {
  beforeEach(() => {
    useIsMobileMock.mockReturnValue(true);
  });

  it('gives every trigger a 44px hit area and keeps it outside links', () => {
    render(<ProjectTrack view={EXPERT_VIEW} />);
    const triggers = screen.getAllByRole('button').filter((b) => b.hasAttribute('aria-expanded'));
    expect(triggers).toHaveLength(8);
    for (const trigger of triggers) {
      expect(trigger).toHaveClass('min-h-11');
      expect(trigger.closest('a')).toBeNull();
    }
  });

  it('opens the sentence inline with aria-expanded and aria-controls, and tracks it', async () => {
    const user = userEvent.setup();
    render(<ProjectTrack view={COMPANY_VIEW} />);
    const trigger = screen.getByRole('button', { name: 'Interest' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).not.toHaveAttribute('aria-controls');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const panelId = trigger.getAttribute('aria-controls') ?? '';
    const panel = document.getElementById(panelId);
    expect(panel).toHaveTextContent(PARTICIPANT_STAGES.client[1]?.explanation ?? 'missing');
    expect(trigger).toHaveClass('text-primary');
    expect(track).toHaveBeenCalledWith(DASHBOARD_EVENTS.TRACK_TERM_OPENED, {
      workspace_type: 'company',
      target: 'stage',
      key: 'interest',
      via: 'tap',
    });
  });

  it('keeps one open at a time and closes on a second tap', async () => {
    const user = userEvent.setup();
    render(<ProjectTrack view={EXPERT_VIEW} />);
    const first = screen.getByRole('button', { name: 'Invited' });
    const second = screen.getByRole('button', { name: 'Kickoff' });
    await user.click(first);
    await user.click(second);
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(second).toHaveAttribute('aria-expanded', 'true');
    await user.click(second);
    expect(second).toHaveAttribute('aria-expanded', 'false');
    expect(track).toHaveBeenCalledTimes(2);
  });

  it('renders one block under the legend for a legend tap', async () => {
    const user = userEvent.setup();
    render(<ProjectTrack view={EXPERT_VIEW} />);
    await user.click(screen.getByRole('button', { name: 'Waiting on client' }));
    const sentence = screen.getAllByText(TURN_EXPLANATIONS.expert.waiting);
    expect(sentence).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'In progress' }));
    expect(screen.queryByText(TURN_EXPLANATIONS.expert.waiting)).not.toBeInTheDocument();
    expect(screen.getByText(TURN_EXPLANATIONS.expert.in_progress)).toBeInTheDocument();
    expect(track).toHaveBeenLastCalledWith(DASHBOARD_EVENTS.TRACK_TERM_OPENED, {
      workspace_type: 'expert',
      target: 'legend',
      key: 'in_progress',
      via: 'tap',
    });
  });

  it('has no accessibility violations with a panel open, on both lenses', async () => {
    const user = userEvent.setup();
    for (const view of [EXPERT_VIEW, COMPANY_VIEW]) {
      const { container, unmount } = render(<ProjectTrack view={view} />);
      await user.click(screen.getByRole('button', { name: view.stages[0]?.label ?? '' }));
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});
