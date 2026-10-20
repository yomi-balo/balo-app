import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';

vi.mock('./your-move', () => ({
  YourMove: ({
    data,
    workspaceType,
  }: {
    data: { kind: string; cards: unknown[]; rows?: unknown };
    workspaceType: string;
  }) => (
    <div data-testid="your-move" data-has-rows={String('rows' in data)}>
      {`${workspaceType}:${data.kind}:${data.cards.length}`}
    </div>
  ),
}));

vi.mock('./project-track', () => ({
  ProjectTrack: ({ view }: { view: { workspaceType: string; stages: unknown[] } }) => (
    <div data-testid="project-track">{`${view.workspaceType}:${view.stages.length}`}</div>
  ),
}));

const mockLoad = vi.fn();
vi.mock('../_lib/load-your-move', () => ({
  loadExpertYourMove: (...args: unknown[]) => mockLoad(...args),
}));

vi.mock('@/lib/logging', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { YourMoveSlot } from './your-move-slot';
import { log } from '@/lib/logging';
import type { SessionUser } from '@/lib/auth/session';

const USER = { id: 'u-1' } as SessionUser;

const LIVE_ROWS = [
  {
    id: 'p1',
    href: '/projects/p1',
    title: 'Project 1',
    companyName: 'Northwind',
    stage: 'eoi',
    needsYou: true,
    kind: 'request',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('YourMoveSlot', () => {
  it('loads for the expert profile and renders the rail with the cards', async () => {
    mockLoad.mockResolvedValue({ cards: [{ id: 'c1' }, { id: 'c2' }], rows: LIVE_ROWS });
    render(
      await YourMoveSlot({
        user: USER,
        expertProfileId: 'profile-1',
        calendarNeedsReconnect: false,
      })
    );
    expect(mockLoad).toHaveBeenCalledWith({
      user: { id: 'u-1', expertProfileId: 'profile-1' },
      calendarNeedsReconnect: false,
    });
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('your-move')).toHaveTextContent('expert:ready:2');
    expect(screen.getByTestId('project-track')).toHaveTextContent('expert:5');
    expect(screen.getByTestId('your-move')).toHaveAttribute('data-has-rows', 'false');
  });

  it('renders no track when the read has no live rows', async () => {
    mockLoad.mockResolvedValue({ cards: [], rows: [] });
    render(
      await YourMoveSlot({
        user: USER,
        expertProfileId: 'profile-1',
        calendarNeedsReconnect: false,
      })
    );
    expect(screen.getByTestId('your-move')).toBeInTheDocument();
    expect(screen.queryByTestId('project-track')).not.toBeInTheDocument();
  });

  it('renders the error state, keeping the calendar blocker, when the read throws', async () => {
    mockLoad.mockRejectedValue(new Error('boom'));
    render(
      await YourMoveSlot({ user: USER, expertProfileId: 'profile-1', calendarNeedsReconnect: true })
    );
    expect(screen.getByTestId('your-move')).toHaveTextContent('expert:error:1');
    expect(screen.queryByTestId('project-track')).not.toBeInTheDocument();
    expect(log.error).toHaveBeenCalled();
  });

  it('renders the error state with no cards when the read throws and the calendar is fine', async () => {
    mockLoad.mockRejectedValue(new Error('boom'));
    render(
      await YourMoveSlot({
        user: USER,
        expertProfileId: 'profile-1',
        calendarNeedsReconnect: false,
      })
    );
    expect(screen.getByTestId('your-move')).toHaveTextContent('expert:error:0');
  });
});
