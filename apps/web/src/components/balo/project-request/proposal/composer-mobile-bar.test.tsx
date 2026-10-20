import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { ComposerMobileBar } from './composer-mobile-bar';
import {
  emptyDraftState,
  type ReadinessIssue,
  type ReadinessResult,
} from './proposal-composer-state';

const OVERVIEW_ISSUE: ReadinessIssue = {
  id: 'overview',
  label: 'Add an overview',
  targetId: 'proposal-overview',
};
const NOT_READY: ReadinessResult = {
  ready: false,
  issues: [
    OVERVIEW_ISSUE,
    { id: 'price', label: 'Set your project price', targetId: 'proposal-fixed-price' },
  ],
};
const READY: ReadinessResult = { ready: true, issues: [] };

function renderBar(
  readiness: ReadinessResult,
  reviseMode = false
): { onJumpFirst: ReturnType<typeof vi.fn>; onPreview: ReturnType<typeof vi.fn> } {
  const onJumpFirst = vi.fn();
  const onPreview = vi.fn();
  render(
    <ComposerMobileBar
      state={{ ...emptyDraftState(), fixedPriceCents: 500_000 }}
      totalCents={500_000}
      readiness={readiness}
      reviseMode={reviseMode}
      onJumpFirst={onJumpFirst}
      onPreview={onPreview}
    />
  );
  return { onJumpFirst, onPreview };
}

describe('ComposerMobileBar', () => {
  it('shows the expert total and routes the issue count to the first issue', async () => {
    const user = userEvent.setup();
    const { onJumpFirst } = renderBar(NOT_READY);

    expect(screen.getByText('A$5,000')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '2 things left' }));

    expect(onJumpFirst).toHaveBeenCalledTimes(1);
  });

  it('never disabled: previews even with issues left', async () => {
    const user = userEvent.setup();
    const { onPreview } = renderBar(NOT_READY);

    const cta = screen.getByRole('button', { name: 'Preview and send' });
    expect(cta).toBeEnabled();
    await user.click(cta);

    expect(onPreview).toHaveBeenCalledTimes(1);
  });

  it('reads Ready to send and relabels for revise mode', () => {
    renderBar(READY, true);

    expect(screen.getByText('Ready to send')).toBeInTheDocument();
    expect(screen.queryByText(/left$/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview and resend' })).toBeInTheDocument();
  });

  it('uses the singular for one issue', () => {
    render(
      <ComposerMobileBar
        state={emptyDraftState()}
        totalCents={0}
        readiness={{ ready: false, issues: [OVERVIEW_ISSUE] }}
        reviseMode={false}
        onJumpFirst={vi.fn()}
        onPreview={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: '1 thing left' })).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
