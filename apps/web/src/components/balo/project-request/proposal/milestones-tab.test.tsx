import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { MilestonesTab } from './milestones-tab';
import type { ProposalMilestoneDraft, ProposalPricingMethod } from './proposal-composer-state';

// The light milestone-description editor uses TipTap — swap for a textarea.
vi.mock('@/components/balo/rich-text-editor', () => ({
  RichTextEditor: (props: {
    value: string;
    onChange: (html: string) => void;
    ariaLabel?: string;
  }) => (
    <textarea
      aria-label={props.ariaLabel}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    />
  ),
}));

let keySeed = 0;
function milestone(partial: Partial<ProposalMilestoneDraft> = {}): ProposalMilestoneDraft {
  keySeed += 1;
  return {
    key: `m-${keySeed}`,
    title: '',
    descriptionHtml: '',
    acceptanceCriteria: '',
    valueCents: 0,
    estimatedMinutes: null,
    ...partial,
  };
}

function renderTab(opts: {
  milestones: ProposalMilestoneDraft[];
  method?: ProposalPricingMethod;
}): {
  onChange: ReturnType<typeof vi.fn<(next: ProposalMilestoneDraft[]) => void>>;
  onAdd: ReturnType<typeof vi.fn>;
} {
  const onChange = vi.fn<(next: ProposalMilestoneDraft[]) => void>();
  const onAdd = vi.fn();
  render(
    <MilestonesTab
      milestones={opts.milestones}
      pricingMethod={opts.method ?? 'fixed'}
      onChange={onChange}
      onAdd={onAdd}
    />
  );
  return { onChange, onAdd };
}

describe('MilestonesTab', () => {
  it('calls onAdd when "Add milestone" is clicked', async () => {
    const user = userEvent.setup();
    const { onAdd } = renderTab({ milestones: [milestone()] });
    await user.click(screen.getByRole('button', { name: /add milestone/i }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('removes a milestone (remove disabled when only one remains)', async () => {
    const user = userEvent.setup();
    const a = milestone({ title: 'A' });
    const b = milestone({ title: 'B' });
    const { onChange } = renderTab({ milestones: [a, b] });
    await user.click(screen.getByRole('button', { name: 'Remove milestone 1' }));
    expect(onChange).toHaveBeenCalledWith([b]);
  });

  it('disables remove for the only milestone', () => {
    renderTab({ milestones: [milestone({ title: 'Solo' })] });
    expect(screen.getByRole('button', { name: 'Remove milestone 1' })).toBeDisabled();
  });

  it('reorders a milestone down (swap with the next)', async () => {
    const user = userEvent.setup();
    const a = milestone({ title: 'A' });
    const b = milestone({ title: 'B' });
    const { onChange } = renderTab({ milestones: [a, b] });
    await user.click(screen.getByRole('button', { name: 'Move milestone 1 down' }));
    expect(onChange).toHaveBeenCalledWith([b, a]);
  });

  it('disables up on the first row and down on the last', () => {
    renderTab({ milestones: [milestone({ title: 'A' }), milestone({ title: 'B' })] });
    expect(screen.getByRole('button', { name: 'Move milestone 1 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move milestone 2 down' })).toBeDisabled();
  });

  it('parses the value input from dollars to integer cents', async () => {
    const user = userEvent.setup();
    const a = milestone({ title: 'A', valueCents: null });
    const { onChange } = renderTab({ milestones: [a] });
    await user.type(screen.getByLabelText('Value'), '9');
    // Controlled by valueCents=null (empty) → first keystroke "9" → 900 cents.
    expect(onChange).toHaveBeenLastCalledWith([{ ...a, valueCents: 900 }]);
  });

  it('shows the value input for Fixed and the effort input for T&M (mutually exclusive)', () => {
    const { rerender } = render(
      <MilestonesTab
        milestones={[milestone({ title: 'A' })]}
        pricingMethod="fixed"
        onChange={vi.fn()}
        onAdd={vi.fn()}
      />
    );
    expect(screen.getByLabelText('Value')).toBeInTheDocument();
    expect(screen.queryByLabelText('Estimated effort')).not.toBeInTheDocument();

    rerender(
      <MilestonesTab
        milestones={[milestone({ title: 'A' })]}
        pricingMethod="tm"
        onChange={vi.fn()}
        onAdd={vi.fn()}
      />
    );
    expect(screen.queryByLabelText('Value')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Estimated effort')).toBeInTheDocument();
  });

  it('parses the effort input from hours to integer minutes (T&M)', async () => {
    const user = userEvent.setup();
    const a = milestone({ title: 'A', valueCents: null, estimatedMinutes: null });
    const { onChange } = renderTab({ milestones: [a], method: 'tm' });
    // Empty (null) → typing "2" → 2h → 120 minutes.
    await user.type(screen.getByLabelText('Estimated effort'), '2');
    expect(onChange).toHaveBeenLastCalledWith([{ ...a, estimatedMinutes: 120 }]);
  });

  it('renders a fractional-hour effort value back from stored minutes (90 → 1.5)', () => {
    renderTab({
      milestones: [milestone({ title: 'A', valueCents: null, estimatedMinutes: 90 })],
      method: 'tm',
    });
    expect(screen.getByLabelText('Estimated effort')).toHaveValue(1.5);
  });

  it('clears the effort to null when the input is emptied (non-negative tolerant)', async () => {
    const user = userEvent.setup();
    const a = milestone({ title: 'A', valueCents: null, estimatedMinutes: 60 });
    const { onChange } = renderTab({ milestones: [a], method: 'tm' });
    await user.clear(screen.getByLabelText('Estimated effort'));
    expect(onChange).toHaveBeenLastCalledWith([{ ...a, estimatedMinutes: null }]);
  });

  it('edits the title via the title input', async () => {
    const user = userEvent.setup();
    const a = milestone({ title: '' });
    const { onChange } = renderTab({ milestones: [a] });
    await user.type(screen.getByLabelText('Title'), 'D');
    expect(onChange).toHaveBeenLastCalledWith([{ ...a, title: 'D' }]);
  });
});
