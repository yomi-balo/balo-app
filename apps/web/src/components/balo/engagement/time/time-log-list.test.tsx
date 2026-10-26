import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';

import { TimeLogList } from './time-log-list';
import { entryView, milestoneTimeView } from './fixtures';

describe('TimeLogList', () => {
  it('lists each entry with its day, note and hours, and who logged them', () => {
    render(
      <TimeLogList
        time={milestoneTimeView({
          entries: [
            entryView(),
            entryView({ id: 'te-2', note: 'Wrote it up', hoursLabel: '1 hr' }),
          ],
        })}
      />
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Mapped the discovery flows')).toBeInTheDocument();
    expect(screen.getByText('1.5 hrs')).toBeInTheDocument();
    expect(screen.getAllByText('12 Oct')).toHaveLength(2);
    expect(screen.getByText('Logged by Priya')).toBeInTheDocument();
  });

  it('omits the authors line when there is none', () => {
    render(<TimeLogList time={milestoneTimeView({ authorsLabel: null })} />);
    expect(screen.queryByText(/Logged by/)).not.toBeInTheDocument();
  });

  it('renders per-entry controls only when given', () => {
    const { rerender } = render(<TimeLogList time={milestoneTimeView()} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    rerender(
      <TimeLogList
        time={milestoneTimeView()}
        renderEntryControls={(entry) => <button type="button">Edit {entry.id}</button>}
      />
    );
    expect(screen.getByRole('button', { name: 'Edit te-1' })).toBeInTheDocument();
  });
});
