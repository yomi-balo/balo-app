import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarProviderButton } from './calendar-provider-button';

describe('CalendarProviderButton', () => {
  it('renders Google Calendar label for google provider', () => {
    render(<CalendarProviderButton provider="google" onClick={vi.fn()} />);
    expect(screen.getByText('Google Calendar')).toBeInTheDocument();
    expect(screen.getByText('Gmail or Google Workspace')).toBeInTheDocument();
  });

  it('renders Microsoft 365 label for microsoft provider', () => {
    render(<CalendarProviderButton provider="microsoft" onClick={vi.fn()} />);
    expect(screen.getByText('Microsoft 365')).toBeInTheDocument();
    expect(screen.getByText('Outlook or Microsoft 365')).toBeInTheDocument();
  });

  it('shows Connect CTA when not already connected', () => {
    render(<CalendarProviderButton provider="google" onClick={vi.fn()} />);
    expect(screen.getByText('Connect')).toBeInTheDocument();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });

  it('shows Connected badge when alreadyConnected is true', () => {
    render(<CalendarProviderButton provider="google" onClick={vi.fn()} alreadyConnected={true} />);
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.queryByText('Connect')).not.toBeInTheDocument();
  });

  it('calls onClick when clicked and not already connected', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<CalendarProviderButton provider="google" onClick={onClick} />);

    await user.click(screen.getByText('Google Calendar'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not call onClick when already connected', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<CalendarProviderButton provider="google" onClick={onClick} alreadyConnected={true} />);

    await user.click(screen.getByText('Google Calendar'));
    expect(onClick).not.toHaveBeenCalled();
  });
});
