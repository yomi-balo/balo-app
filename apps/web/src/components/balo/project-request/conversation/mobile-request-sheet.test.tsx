import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { MobileRequestSheet, useDismissRequestSheet } from './mobile-request-sheet';

describe('MobileRequestSheet', () => {
  it('renders the slim request bar with eyebrow + truncated title', () => {
    render(
      <MobileRequestSheet title="CPQ implementation">
        <div>Server-rendered context</div>
      </MobileRequestSheet>
    );
    expect(screen.getByText('Request')).toBeInTheDocument();
    expect(screen.getByText('CPQ implementation')).toBeInTheDocument();
    // Sheet content stays unmounted until opened.
    expect(screen.queryByText('Server-rendered context')).not.toBeInTheDocument();
  });

  it('opens the bottom sheet with the server-rendered children', async () => {
    const user = userEvent.setup();
    render(
      <MobileRequestSheet title="CPQ implementation">
        <div>Server-rendered context</div>
      </MobileRequestSheet>
    );
    await user.click(
      screen.getByRole('button', { name: 'Request, kickoff and files: CPQ implementation' })
    );
    expect(await screen.findByText('Request, kickoff and files')).toBeInTheDocument();
    expect(screen.getByText('Server-rendered context')).toBeInTheDocument();
  });

  it('lets a control inside close the sheet, so a second overlay never stacks on it', async () => {
    function OpenOther(): React.JSX.Element {
      const dismiss = useDismissRequestSheet();
      return (
        <button type="button" onClick={() => dismiss?.()}>
          Open All files
        </button>
      );
    }
    const user = userEvent.setup();
    render(
      <MobileRequestSheet title="CPQ implementation">
        <OpenOther />
      </MobileRequestSheet>
    );
    await user.click(
      screen.getByRole('button', { name: 'Request, kickoff and files: CPQ implementation' })
    );
    await user.click(await screen.findByRole('button', { name: 'Open All files' }));
    await waitFor(() =>
      expect(screen.queryByText('Request, kickoff and files')).not.toBeInTheDocument()
    );
  });
});
