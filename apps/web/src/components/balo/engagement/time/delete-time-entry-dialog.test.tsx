import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

const { run, removeTimeEntryAction } = vi.hoisted(() => ({
  run: vi.fn(),
  removeTimeEntryAction: vi.fn(),
}));
let mockPending = false;

vi.mock('../use-engagement-lifecycle-action', () => ({
  useEngagementLifecycleAction: () => ({ isPending: mockPending, run }),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/remove-time-entry', () => ({
  removeTimeEntryAction,
}));

import { DeleteTimeEntryDialog } from './delete-time-entry-dialog';
import { entryView } from './fixtures';

function setup(entry = entryView({ canDelete: true })) {
  const onClose = vi.fn();
  render(
    <DeleteTimeEntryDialog
      engagementId="eng-1"
      entry={entry}
      clientCompanyName="Northwind"
      onClose={onClose}
    />
  );
  return { onClose };
}

describe('DeleteTimeEntryDialog', () => {
  beforeEach(() => {
    mockPending = false;
    run.mockClear();
    removeTimeEntryAction.mockReset().mockResolvedValue({ success: true });
  });

  it('asks before deleting and says what goes', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Delete this time entry?' })).toBeInTheDocument();
    expect(screen.getByText(/1\.5 hrs on 12 Oct/)).toBeInTheDocument();
    expect(screen.getByText(/Northwind no longer sees it/)).toBeInTheDocument();
  });

  it('removes the entry and toasts through the lifecycle hook', async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.click(screen.getByRole('button', { name: 'Delete entry' }));
    expect(removeTimeEntryAction).toHaveBeenCalledWith({ engagementId: 'eng-1', entryId: 'te-1' });
    expect(run).toHaveBeenCalledWith(expect.anything(), 'Time entry deleted', onClose);
  });

  it('keeps the entry from the button and from Escape, even mid-save', async () => {
    const user = userEvent.setup();
    mockPending = true;
    const { onClose } = setup();
    expect(screen.getByRole('button', { name: 'Delete entry' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Keep entry' }));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(removeTimeEntryAction).not.toHaveBeenCalled();
  });

  it('renders nothing while there is no entry', () => {
    const onClose = vi.fn();
    render(
      <DeleteTimeEntryDialog
        engagementId="eng-1"
        entry={null}
        clientCompanyName="Northwind"
        onClose={onClose}
      />
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
