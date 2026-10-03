import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { GenerationErrorBanner } from './generation-error-banner';

describe('GenerationErrorBanner', () => {
  describe('upload variant', () => {
    it('shows reason-specific copy and the Try again / Write it myself actions', async () => {
      const onRetry = vi.fn();
      const onWriteItMyself = vi.fn();
      const user = userEvent.setup();
      render(
        <GenerationErrorBanner
          reason="too_large"
          variant="upload"
          onRetry={onRetry}
          onWriteItMyself={onWriteItMyself}
        />
      );

      expect(screen.getByText(/a bit much to read/i)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /try again/i }));
      expect(onRetry).toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: /write it myself instead/i }));
      expect(onWriteItMyself).toHaveBeenCalled();
    });
  });

  describe('review variant', () => {
    it('shows the fixed regenerate-failure copy and a Dismiss action', async () => {
      const onDismiss = vi.fn();
      const user = userEvent.setup();
      render(<GenerationErrorBanner reason="unknown" variant="review" onDismiss={onDismiss} />);

      expect(screen.getByText(/your previous draft is unchanged/i)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /dismiss/i }));
      expect(onDismiss).toHaveBeenCalled();
    });
  });

  // BAL-589 — the case-conversion manual step's failure state.
  describe('case variant', () => {
    it('shows the SAME copy regardless of reason', () => {
      const { rerender } = render(
        <GenerationErrorBanner reason="case_unavailable" variant="case" />
      );
      expect(
        screen.getByText("We couldn't draft a brief from this case — write it yourself below.")
      ).toBeInTheDocument();

      rerender(<GenerationErrorBanner reason="no_case_history" variant="case" />);
      expect(
        screen.getByText("We couldn't draft a brief from this case — write it yourself below.")
      ).toBeInTheDocument();

      rerender(<GenerationErrorBanner reason="unknown" variant="case" />);
      expect(
        screen.getByText("We couldn't draft a brief from this case — write it yourself below.")
      ).toBeInTheDocument();
    });

    it('offers Try again and Dismiss, never Write it myself', async () => {
      const onRetry = vi.fn();
      const onDismiss = vi.fn();
      const user = userEvent.setup();
      render(
        <GenerationErrorBanner
          reason="case_unavailable"
          variant="case"
          onRetry={onRetry}
          onDismiss={onDismiss}
        />
      );

      expect(screen.queryByRole('button', { name: /write it myself/i })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /try again/i }));
      expect(onRetry).toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: /dismiss/i }));
      expect(onDismiss).toHaveBeenCalled();
    });
  });
});
