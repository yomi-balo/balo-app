import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';

vi.mock('./your-move', () => ({
  YourMove: ({ data }: { data: { kind: string; cards: unknown[] } }) => (
    <div data-testid="your-move">{`${data.kind}:${data.cards.length}`}</div>
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('YourMoveSlot', () => {
  it('loads for the expert profile and renders the rail with the cards', async () => {
    mockLoad.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
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
    expect(screen.getByTestId('your-move')).toHaveTextContent('ready:2');
  });

  it('renders the error state, keeping the calendar blocker, when the read throws', async () => {
    mockLoad.mockRejectedValue(new Error('boom'));
    render(
      await YourMoveSlot({ user: USER, expertProfileId: 'profile-1', calendarNeedsReconnect: true })
    );
    expect(screen.getByTestId('your-move')).toHaveTextContent('error:1');
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
    expect(screen.getByTestId('your-move')).toHaveTextContent('error:0');
  });
});
