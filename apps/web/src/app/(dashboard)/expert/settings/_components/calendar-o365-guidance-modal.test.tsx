import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarO365GuidanceModal } from './calendar-o365-guidance-modal';

describe('CalendarO365GuidanceModal', () => {
  it('does not render dialog content when closed', () => {
    render(<CalendarO365GuidanceModal open={false} onContinue={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders a titled, described dialog with the four-step "what to expect" list', () => {
    render(<CalendarO365GuidanceModal open onContinue={vi.fn()} onCancel={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('Connect Microsoft 365')).toBeInTheDocument();
    expect(screen.getByText('Outlook or Microsoft 365 work account')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });

  it('calls onContinue when "Continue to Microsoft 365" is clicked', async () => {
    const onContinue = vi.fn();
    const user = userEvent.setup();
    render(<CalendarO365GuidanceModal open onContinue={onContinue} onCancel={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Continue to Microsoft 365/ }));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('calls onCancel when the Cancel button is clicked', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<CalendarO365GuidanceModal open onContinue={vi.fn()} onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('calls onCancel on Esc dismissal too, not just the Cancel button', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<CalendarO365GuidanceModal open onContinue={vi.fn()} onCancel={onCancel} />);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
