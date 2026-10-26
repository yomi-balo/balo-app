import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import {
  DRAFT_FAILED_LINE,
  DraftBadge,
  DraftFailedNote,
  DraftSuggestion,
  DraftingLabel,
  DraftingSkeleton,
  MOBILE_DRAFTING,
  SUGGESTED_LABEL,
  draftedLabel,
  draftingLabel,
} from './proposal-draft-indicators';

describe('proposal draft indicators', () => {
  it('builds the drafting and drafted labels from the client first name', () => {
    expect(draftingLabel('Dana')).toBe("Drafting from Dana's request…");
    expect(draftedLabel('Dana')).toBe("Drafted from Dana's request");
    expect(MOBILE_DRAFTING).toBe('Drafting…');
    expect(SUGGESTED_LABEL).toBe('Suggested from the brief');
    expect(DRAFT_FAILED_LINE).toBe("Couldn't draft this one. Start from scratch.");
  });

  it('DraftingLabel is a status line', () => {
    render(<DraftingLabel label="Drafting from Dana's request…" />);
    expect(screen.getByRole('status')).toHaveTextContent("Drafting from Dana's request…");
  });

  it('a decorative DraftingLabel is hidden from assistive tech and is not a status', () => {
    render(<DraftingLabel label="Drafting from Dana's request…" decorative />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText("Drafting from Dana's request…")).toHaveAttribute(
      'aria-hidden',
      'true'
    );
  });

  it('the skeleton card fills its container', () => {
    render(<DraftingSkeleton variant="overview" />);
    expect(screen.getByTestId('draft-skeleton-overview')).toHaveClass('h-full');
  });

  it('overview skeleton shows five hidden bars and the label', () => {
    render(<DraftingSkeleton variant="overview" label="Drafting from Dana's request…" />);
    const skeleton = screen.getByTestId('draft-skeleton-overview');
    expect(skeleton.querySelectorAll('[aria-hidden="true"].animate-pulse')).toHaveLength(5);
    expect(skeleton.querySelector('.motion-reduce\\:animate-none')).not.toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent("Drafting from Dana's request…");
  });

  it('milestones skeleton draws three rows of bars and no label', () => {
    render(<DraftingSkeleton variant="milestones" />);
    const skeleton = screen.getByTestId('draft-skeleton-milestones');
    expect(skeleton.querySelectorAll('.animate-pulse')).toHaveLength(6);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('DraftBadge shows its label and fires Clear', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    render(<DraftBadge label="Drafted from Dana's request" onClear={onClear} />);
    expect(screen.getByText("Drafted from Dana's request")).toBeInTheDocument();
    const clear = screen.getByRole('button', { name: 'Clear drafted overview' });
    expect(clear).toHaveTextContent('Clear');
    expect(clear).toHaveClass('text-primary', 'text-[13.5px]');
    await user.click(clear);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('DraftSuggestion shows the marker and fires Clear', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    render(<DraftSuggestion onClear={onClear} />);
    expect(screen.getByText('Suggested from the brief')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear suggested milestones' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('DraftFailedNote is a muted status line with the quiet copy', () => {
    render(<DraftFailedNote />);
    expect(screen.getByRole('status')).toHaveTextContent(
      "Couldn't draft this one. Start from scratch."
    );
  });
});
