import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { track, HELP_EVENTS } from '@/lib/analytics';
import { GuideFeedback } from './guide-feedback';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GuideFeedback', () => {
  it('tracks a helpful verdict without a comment and says thanks', async () => {
    render(<GuideFeedback slug="booking" />);

    await userEvent.click(screen.getByRole('button', { name: 'Yes' }));

    expect(track).toHaveBeenCalledWith(HELP_EVENTS.FEEDBACK_SUBMITTED, {
      slug: 'booking',
      helpful: true,
      has_comment: false,
    });
    expect(screen.getByText('Thanks for letting us know.')).toBeInTheDocument();
  });

  it('names the Yes/No group', () => {
    render(<GuideFeedback slug="booking" />);

    expect(screen.getByRole('group', { name: 'Did this guide help?' })).toBeInTheDocument();
  });

  it('moves focus to the note field on No', async () => {
    render(<GuideFeedback slug="booking" />);

    await userEvent.click(screen.getByRole('button', { name: 'No' }));

    expect(screen.getByLabelText('What were you trying to do?')).toHaveFocus();
  });

  it('does not track on No alone; it asks what they were trying to do', async () => {
    render(<GuideFeedback slug="booking" />);

    await userEvent.click(screen.getByRole('button', { name: 'No' }));

    expect(track).not.toHaveBeenCalled();
    expect(screen.getByLabelText('What were you trying to do?')).toBeInTheDocument();
  });

  it('sends a trimmed note on Send', async () => {
    render(<GuideFeedback slug="booking" />);
    await userEvent.click(screen.getByRole('button', { name: 'No' }));

    await userEvent.type(screen.getByLabelText('What were you trying to do?'), '  x  ');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(track).toHaveBeenCalledWith(HELP_EVENTS.FEEDBACK_SUBMITTED, {
      slug: 'booking',
      helpful: false,
      has_comment: true,
      comment: 'x',
    });
    expect(screen.getByText('Thanks. Your note will help us fix this guide.')).toBeInTheDocument();
  });

  it('sends no comment key on Skip, even with text typed', async () => {
    render(<GuideFeedback slug="booking" />);
    await userEvent.click(screen.getByRole('button', { name: 'No' }));
    await userEvent.type(screen.getByLabelText('What were you trying to do?'), 'typed');

    await userEvent.click(screen.getByRole('button', { name: 'Skip' }));

    expect(track).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(track).mock.calls[0]?.[1];
    expect(payload).toEqual({ slug: 'booking', helpful: false, has_comment: false });
    expect(payload).not.toHaveProperty('comment');
    expect(screen.getByText('Thanks for letting us know.')).toBeInTheDocument();
  });

  it('caps the note field at 1,000 characters', async () => {
    render(<GuideFeedback slug="booking" />);
    await userEvent.click(screen.getByRole('button', { name: 'No' }));

    expect(screen.getByLabelText('What were you trying to do?')).toHaveAttribute(
      'maxlength',
      '1000'
    );
  });

  it('treats a blank Send as a skip', async () => {
    render(<GuideFeedback slug="booking" />);
    await userEvent.click(screen.getByRole('button', { name: 'No' }));

    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(track).toHaveBeenCalledWith(HELP_EVENTS.FEEDBACK_SUBMITTED, {
      slug: 'booking',
      helpful: false,
      has_comment: false,
    });
  });
});
