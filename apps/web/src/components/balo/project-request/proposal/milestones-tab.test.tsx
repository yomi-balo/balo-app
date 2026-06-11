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

  it('shows the value column only for Fixed pricing', () => {
    const { rerender } = render(
      <MilestonesTab
        milestones={[milestone({ title: 'A' })]}
        pricingMethod="fixed"
        onChange={vi.fn()}
        onAdd={vi.fn()}
      />
    );
    expect(screen.getByLabelText('Value')).toBeInTheDocument();

    rerender(
      <MilestonesTab
        milestones={[milestone({ title: 'A' })]}
        pricingMethod="tm"
        onChange={vi.fn()}
        onAdd={vi.fn()}
      />
    );
    expect(screen.queryByLabelText('Value')).not.toBeInTheDocument();
  });

  it('edits the title via the title input', async () => {
    const user = userEvent.setup();
    const a = milestone({ title: '' });
    const { onChange } = renderTab({ milestones: [a] });
    await user.type(screen.getByLabelText('Title'), 'D');
    expect(onChange).toHaveBeenLastCalledWith([{ ...a, title: 'D' }]);
  });
});
