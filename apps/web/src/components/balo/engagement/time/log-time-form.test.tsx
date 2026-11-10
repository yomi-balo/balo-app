import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

const { run, logTimeAction, updateTimeEntryAction } = vi.hoisted(() => ({
  run: vi.fn(),
  logTimeAction: vi.fn(),
  updateTimeEntryAction: vi.fn(),
}));
let mockPending = false;

vi.mock('../use-engagement-lifecycle-action', () => ({
  useEngagementLifecycleAction: () => ({ isPending: mockPending, run }),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/log-time', () => ({ logTimeAction }));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/update-time-entry', () => ({
  updateTimeEntryAction,
}));

import { LogTimeForm } from './log-time-form';
import { entryView } from './fixtures';

function setup(overrides: Partial<React.ComponentProps<typeof LogTimeForm>> = {}) {
  const onClose = vi.fn();
  render(
    <LogTimeForm
      engagementId="eng-1"
      milestoneId="m-1"
      milestoneTitle="Discovery"
      estimatedMinutes={480}
      loggedMinutes={420}
      clientCompanyName="Northwind"
      overNoticeSent={false}
      onClose={onClose}
      {...overrides}
    />
  );
  return { onClose };
}

describe('LogTimeForm', () => {
  beforeEach(() => {
    mockPending = false;
    run.mockClear();
    logTimeAction.mockReset().mockResolvedValue({ success: true });
    updateTimeEntryAction.mockReset().mockResolvedValue({ success: true });
  });

  it('defaults to one hour, tells the client sees every note, and holds Log time until a note', async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.getByLabelText('Hours')).toHaveValue(1);
    expect(screen.getByLabelText('Hours')).toHaveAttribute('step', '0.25');
    expect(screen.getByText('Northwind sees every entry and its note.')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Log time' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Note'), '   ');
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Note'), 'Wrote the plan');
    expect(submit).toBeEnabled();
  });

  it('logs the minutes and the trimmed note, toasting through the lifecycle hook', async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.clear(screen.getByLabelText('Hours'));
    await user.type(screen.getByLabelText('Hours'), '1.25');
    await user.type(screen.getByLabelText('Note'), '  Wrote the plan ');
    await user.click(screen.getByRole('button', { name: 'Log time' }));
    expect(logTimeAction).toHaveBeenCalledWith({
      engagementId: 'eng-1',
      milestoneId: 'm-1',
      minutes: 75,
      note: 'Wrote the plan',
    });
    expect(run).toHaveBeenCalledWith(expect.anything(), 'Time logged', onClose);
  });

  it.each(['0', '-1', '0.1', '25', ''])('keeps Log time disabled for %j hours', async (hours) => {
    const user = userEvent.setup();
    setup();
    await user.clear(screen.getByLabelText('Hours'));
    if (hours !== '') await user.type(screen.getByLabelText('Hours'), hours);
    await user.type(screen.getByLabelText('Note'), 'Work');
    expect(screen.getByRole('button', { name: 'Log time' })).toBeDisabled();
  });

  it('hints at the grid, with aria-invalid, when the hours are off-grid or out of range', async () => {
    const user = userEvent.setup();
    setup();
    const hours = screen.getByLabelText('Hours');
    expect(hours).not.toHaveAttribute('aria-invalid', 'true');
    await user.clear(hours);
    await user.type(hours, '0.1');
    expect(hours).toHaveAttribute('aria-invalid', 'true');
    const hint = screen.getByText('Use quarter hours, up to 24');
    expect(hours).toHaveAttribute('aria-describedby', hint.id);
    await user.clear(hours);
    await user.type(hours, '25');
    expect(screen.getByText('Use quarter hours, up to 24')).toBeInTheDocument();
    await user.clear(hours);
    await user.type(hours, '1.5');
    expect(screen.queryByText('Use quarter hours, up to 24')).not.toBeInTheDocument();
  });

  it('warns before the entry takes the milestone over its estimate', async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.queryByText(/over its/)).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText('Hours'));
    await user.type(screen.getByLabelText('Hours'), '2');
    expect(
      screen.getByText(
        'This takes Discovery 1 hr over its 8 hrs estimate. Northwind will be notified.'
      )
    ).toBeInTheDocument();
  });

  it('prefills from an entry and saves over it', async () => {
    const user = userEvent.setup();
    const { onClose } = setup({ entry: entryView({ canEdit: true }) });
    expect(screen.getByLabelText('Hours')).toHaveValue(1.5);
    expect(screen.getByLabelText('Note')).toHaveValue('Mapped the discovery flows');
    await user.type(screen.getByLabelText('Note'), '!');
    await user.click(screen.getByRole('button', { name: 'Save entry' }));
    expect(updateTimeEntryAction).toHaveBeenCalledWith({
      engagementId: 'eng-1',
      entryId: 'te-1',
      minutes: 90,
      note: 'Mapped the discovery flows!',
    });
    expect(run).toHaveBeenCalledWith(expect.anything(), 'Time entry updated', onClose);
  });

  it('leaves out the edited entry when warning about an edit', () => {
    setup({
      loggedMinutes: 540,
      entry: entryView({ minutes: 120, note: 'Long day', canEdit: true }),
      estimatedMinutes: 480,
    });
    expect(screen.queryByText(/already over/)).not.toBeInTheDocument();
  });

  it('cancels from the button and from Escape, even while a save is in flight', async () => {
    const user = userEvent.setup();
    mockPending = true;
    const { onClose } = setup();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toBeEnabled();
    await user.click(cancel);
    await user.type(screen.getByLabelText('Note'), '{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Log time' })).toBeDisabled();
  });
});
