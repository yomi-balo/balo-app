import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { LookupSectionRetryNotice } from './lookup-section-retry-notice';

describe('LookupSectionRetryNotice', () => {
  it('renders the message inside the given container class, with no Retry button when showRetry is false', () => {
    const onRetry = vi.fn();
    const { container } = render(
      <LookupSectionRetryNotice
        containerClassName="border-warning/30 bg-warning/5 rounded-xl border p-3.5"
        message="This session's money record isn't available."
        showRetry={false}
        onRetry={onRetry}
      />
    );

    expect(screen.getByText("This session's money record isn't available.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(container.querySelector('.border-warning\\/30')).not.toBeNull();
  });

  it('renders a Retry button that calls onRetry when showRetry is true', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(
      <LookupSectionRetryNotice
        containerClassName=""
        message="These details didn't load. Nothing was changed — retry below."
        showRetry
        onRetry={onRetry}
      />
    );

    const button = screen.getByRole('button', { name: /retry/i });
    await user.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('BAL-666 — renders a title above the message when given one, and none otherwise', () => {
    const { rerender } = render(
      <LookupSectionRetryNotice
        containerClassName=""
        title="Follow-ups could not be loaded"
        message="Something went wrong."
        showRetry={false}
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByText('Follow-ups could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('Follow-ups could not be loaded').parentElement).toHaveClass(
      'justify-center'
    );

    rerender(
      <LookupSectionRetryNotice
        containerClassName=""
        message="Something went wrong."
        showRetry={false}
        onRetry={vi.fn()}
      />
    );
    expect(screen.queryByText('Follow-ups could not be loaded')).not.toBeInTheDocument();
  });
});
