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
    it('shows the SAME generic copy for every reason but no_case_history', () => {
      const { rerender } = render(
        <GenerationErrorBanner reason="case_unavailable" variant="case" />
      );
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

    // X4a — no history to draft from: its own copy, and no Try again (nothing to retry).
    it('no_case_history gets its own copy and drops Try again', async () => {
      const onDismiss = vi.fn();
      const user = userEvent.setup();
      render(
        <GenerationErrorBanner reason="no_case_history" variant="case" onDismiss={onDismiss} />
      );

      expect(
        screen.getByText(
          "This case doesn't have any messages or call notes to draft from yet — write the brief yourself below."
        )
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /dismiss/i }));
      expect(onDismiss).toHaveBeenCalled();
    });

    // X4c — the start action's own error (rate limit, wrong workspace) replaces the generic copy.
    it('shows startError in place of the generic copy, and keeps Try again', () => {
      render(
        <GenerationErrorBanner
          reason="enqueue_failed"
          variant="case"
          startError="Switch to the workspace this case belongs to."
        />
      );

      expect(screen.getByText('Switch to the workspace this case belongs to.')).toBeInTheDocument();
      expect(
        screen.queryByText("We couldn't draft a brief from this case — write it yourself below.")
      ).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    });

    // no_case_history wins even if a stale startError is still set.
    it('no_case_history takes priority over a startError', () => {
      render(
        <GenerationErrorBanner
          reason="no_case_history"
          variant="case"
          startError="Switch to the workspace this case belongs to."
        />
      );

      expect(
        screen.getByText(
          "This case doesn't have any messages or call notes to draft from yet — write the brief yourself below."
        )
      ).toBeInTheDocument();
    });
  });
});
