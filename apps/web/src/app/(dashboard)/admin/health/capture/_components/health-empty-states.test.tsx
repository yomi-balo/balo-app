import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { CaptureHealthEmpty, CaptureHealthFilteredEmpty } from './health-empty-states';

describe('CaptureHealthEmpty (true zero)', () => {
  it('renders the invitation copy, never absence-framed', () => {
    render(<CaptureHealthEmpty />);
    expect(screen.getByText('Nothing has been recorded yet')).toBeInTheDocument();
    expect(
      screen.getByText(/Recording starts when the first Balo Video consultation goes in progress/)
    ).toBeInTheDocument();
  });
});

describe('CaptureHealthFilteredEmpty (windowed / filtered zero)', () => {
  it('shows "Back to all" only when a category filter is active', () => {
    render(<CaptureHealthFilteredEmpty hasCategoryFilter={true} />);
    expect(screen.getByRole('link', { name: /Back to all/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Reset to the last 30 days/ })).toBeInTheDocument();
  });

  it('omits "Back to all" with no category filter', () => {
    render(<CaptureHealthFilteredEmpty hasCategoryFilter={false} />);
    expect(screen.queryByRole('link', { name: /Back to all/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Reset to the last 30 days/ })).toBeInTheDocument();
  });
});
