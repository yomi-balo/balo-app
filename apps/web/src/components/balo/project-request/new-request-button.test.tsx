import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { NewRequestButton } from './new-request-button';

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));

// A data-attribute stub for the lazily mounted panel, so the test reads exactly what the button
// hands it without pulling in Tiptap.
vi.mock('@/components/balo/project-request/panel', () => ({
  ProjectRequestPanel: ({
    open,
    onClose,
    entryPoint,
    expertProfileId,
    onSubmitted,
  }: {
    open: boolean;
    onClose: () => void;
    entryPoint: string;
    expertProfileId?: string;
    onSubmitted?: (id: string) => void;
  }): React.JSX.Element => (
    <div
      data-testid="panel-stub"
      data-open={String(open)}
      data-entry-point={entryPoint}
      data-expert={expertProfileId ?? 'none'}
    >
      <button type="button" onClick={onClose}>
        stub close
      </button>
      <button type="button" onClick={() => onSubmitted?.('req-1')}>
        stub submit
      </button>
    </div>
  ),
}));

describe('NewRequestButton', () => {
  beforeEach(() => {
    mockRefresh.mockClear();
  });

  it('is a button, not a link, and mounts no panel until clicked', () => {
    render(<NewRequestButton label="Raise a project request" entryPoint="projects" />);
    expect(screen.getByRole('button', { name: /raise a project request/i })).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByTestId('panel-stub')).not.toBeInTheDocument();
  });

  it('opens the context-free panel with the projects entry point', async () => {
    const user = userEvent.setup();
    render(<NewRequestButton label="Raise a project request" entryPoint="projects" />);

    await user.click(screen.getByRole('button', { name: /raise a project request/i }));

    const panel = await screen.findByTestId('panel-stub');
    expect(panel).toHaveAttribute('data-open', 'true');
    expect(panel).toHaveAttribute('data-entry-point', 'projects');
    expect(panel).toHaveAttribute('data-expert', 'none');
  });

  it('passes the engagement entry point through', async () => {
    const user = userEvent.setup();
    render(<NewRequestButton label="Start your next project" entryPoint="engagement" />);

    await user.click(screen.getByRole('button', { name: /start your next project/i }));

    expect(await screen.findByTestId('panel-stub')).toHaveAttribute(
      'data-entry-point',
      'engagement'
    );
  });

  it('closes on onClose and stays mounted so the drawer can animate out', async () => {
    const user = userEvent.setup();
    render(<NewRequestButton label="New request" entryPoint="projects" />);

    await user.click(screen.getByRole('button', { name: /new request/i }));
    await user.click(await screen.findByRole('button', { name: 'stub close' }));

    expect(screen.getByTestId('panel-stub')).toHaveAttribute('data-open', 'false');
  });

  it('does not refresh at submit — the refresh would unmount the empty state and the open drawer', async () => {
    const user = userEvent.setup();
    render(<NewRequestButton label="New request" entryPoint="projects" />);

    await user.click(screen.getByRole('button', { name: /new request/i }));
    await user.click(await screen.findByRole('button', { name: 'stub submit' }));

    expect(mockRefresh).not.toHaveBeenCalled();
    expect(screen.getByTestId('panel-stub')).toHaveAttribute('data-open', 'true');
  });

  it('refreshes once when the drawer closes after a submit', async () => {
    const user = userEvent.setup();
    render(<NewRequestButton label="New request" entryPoint="projects" />);

    await user.click(screen.getByRole('button', { name: /new request/i }));
    await user.click(await screen.findByRole('button', { name: 'stub submit' }));
    await user.click(screen.getByRole('button', { name: 'stub close' }));

    expect(mockRefresh).toHaveBeenCalledTimes(1);

    // A later open-and-close with no submit does not refresh again.
    await user.click(screen.getByRole('button', { name: /new request/i }));
    await user.click(screen.getByRole('button', { name: 'stub close' }));

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not refresh when the drawer closes without a submit', async () => {
    const user = userEvent.setup();
    render(<NewRequestButton label="New request" entryPoint="projects" />);

    await user.click(screen.getByRole('button', { name: /new request/i }));
    await user.click(await screen.findByRole('button', { name: 'stub close' }));

    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
