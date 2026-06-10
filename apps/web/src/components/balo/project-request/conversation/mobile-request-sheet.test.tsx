import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { MobileRequestSheet } from './mobile-request-sheet';

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
    await user.click(screen.getByRole('button', { name: 'Request details: CPQ implementation' }));
    expect(await screen.findByText('Request details')).toBeInTheDocument();
    expect(screen.getByText('Server-rendered context')).toBeInTheDocument();
  });
});
