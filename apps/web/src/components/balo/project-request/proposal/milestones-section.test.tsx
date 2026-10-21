import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { MilestonesSection } from './milestones-section';
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
    valueCents: null,
    estimatedMinutes: null,
    ...partial,
  };
}

interface Options {
  method?: ProposalPricingMethod;
  pricing?: boolean;
  fixedPriceCents?: number | null;
  totalCents?: number;
}

interface Spies {
  onToggleMilestonePricing: ReturnType<typeof vi.fn<(enabled: boolean) => void>>;
  onSetPrice: ReturnType<typeof vi.fn<(cents: number) => void>>;
  latest: () => ProposalMilestoneDraft[];
}

/** Stateful harness: the section is controlled, so Enter/Backspace/reorder need a
 *  parent that applies `onChange` for the focus + order assertions to hold. */
function renderSection(initial: ProposalMilestoneDraft[], options: Options = {}): Spies {
  const onToggleMilestonePricing = vi.fn<(enabled: boolean) => void>();
  const onSetPrice = vi.fn<(cents: number) => void>();
  let current = initial;
  function Harness(): React.JSX.Element {
    const [milestones, setMilestones] = useState(initial);
    current = milestones;
    return (
      <MilestonesSection
        milestones={milestones}
        pricingMethod={options.method ?? 'fixed'}
        milestonePricingEnabled={options.pricing ?? false}
        fixedPriceCents={'fixedPriceCents' in options ? (options.fixedPriceCents ?? null) : null}
        totalCents={options.totalCents ?? 0}
        currency="aud"
        onChange={setMilestones}
        onToggleMilestonePricing={onToggleMilestonePricing}
        onSetPrice={onSetPrice}
      />
    );
  }
  render(<Harness />);
  return { onToggleMilestonePricing, onSetPrice, latest: () => current };
}

function titles(): string[] {
  return screen
    .getAllByPlaceholderText('Milestone title')
    .map((el) => (el as HTMLInputElement).value);
}

describe('MilestonesSection — rows', () => {
  it('adds a row on Enter in a title and focuses the new title', async () => {
    const user = userEvent.setup();
    renderSection([milestone({ title: 'A' }), milestone({ title: 'B' })]);
    await user.click(screen.getByLabelText('Milestone 1 title'));
    await user.keyboard('{Enter}');
    expect(titles()).toEqual(['A', '', 'B']);
    expect(screen.getByLabelText('Milestone 2 title')).toHaveFocus();
  });

  it('removes an empty row on Backspace when there are two, and focuses the previous title', async () => {
    const user = userEvent.setup();
    renderSection([milestone({ title: 'A' }), milestone({ title: '' })]);
    await user.click(screen.getByLabelText('Milestone 2 title'));
    await user.keyboard('{Backspace}');
    expect(titles()).toEqual(['A']);
    expect(screen.getByLabelText('Milestone 1 title')).toHaveFocus();
  });

  it('focuses the next title when Backspace removes the first row', async () => {
    const user = userEvent.setup();
    renderSection([milestone({ title: '' }), milestone({ title: 'B' })]);
    await user.click(screen.getByLabelText('Milestone 1 title'));
    await user.keyboard('{Backspace}');
    expect(titles()).toEqual(['B']);
    expect(screen.getByLabelText('Milestone 1 title')).toHaveFocus();
  });

  it('does nothing on Backspace in an empty title when only one row is left', async () => {
    const user = userEvent.setup();
    renderSection([milestone({ title: '' })]);
    await user.click(screen.getByLabelText('Milestone 1 title'));
    await user.keyboard('{Backspace}');
    expect(titles()).toEqual(['']);
  });

  it('does not remove a row on Backspace while the title has text', async () => {
    const user = userEvent.setup();
    renderSection([milestone({ title: 'A' }), milestone({ title: 'B' })]);
    await user.click(screen.getByLabelText('Milestone 2 title'));
    await user.keyboard('{Backspace}');
    expect(titles()).toEqual(['A', '']);
  });

  it('ignores Enter and Backspace during IME composition', async () => {
    const { fireEvent } = await import('@/test/utils');
    renderSection([milestone({ title: '' }), milestone({ title: 'B' })]);
    const input = screen.getByLabelText('Milestone 1 title');
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Backspace', isComposing: true });
    expect(titles()).toEqual(['', 'B']);
  });

  it.each([
    '{Meta>}{Enter}{/Meta}',
    '{Control>}{Enter}{/Control}',
    '{Alt>}{Enter}{/Alt}',
    '{Shift>}{Enter}{/Shift}',
  ])('does not add a row for a modified Enter (%s)', async (keys) => {
    const user = userEvent.setup();
    renderSection([milestone({ title: 'A' })]);
    await user.click(screen.getByLabelText('Milestone 1 title'));
    await user.keyboard(keys);
    expect(titles()).toEqual(['A']);
  });

  it('announces a keyboard move politely', async () => {
    const user = userEvent.setup();
    renderSection([milestone({ title: 'A' }), milestone({ title: '' })]);
    screen.getByRole('button', { name: 'Reorder milestone 1' }).focus();
    await user.keyboard('{ArrowDown}');
    const live = document.querySelector('[aria-live="polite"]');
    expect(live).toHaveTextContent('Moved A to position 2 of 2');
    await user.keyboard('{ArrowUp}');
    expect(live).toHaveTextContent('Moved A to position 1 of 2');
  });

  it('reveals delete on hover-capable devices only and always on focus-within', () => {
    renderSection([milestone({ title: 'A' }), milestone({ title: 'B' })]);
    const cls = screen.getByRole('button', { name: 'Remove milestone 1' }).className;
    expect(cls).toContain('[@media(hover:hover)]:opacity-0');
    expect(cls).toContain('group-focus-within:opacity-100');
  });

  it('reorders with ArrowDown / ArrowUp on the grip and keeps focus on it', async () => {
    const user = userEvent.setup();
    renderSection([milestone({ title: 'A' }), milestone({ title: 'B' })]);
    const grip = screen.getByRole('button', { name: 'Reorder milestone 1' });
    grip.focus();
    await user.keyboard('{ArrowDown}');
    expect(titles()).toEqual(['B', 'A']);
    expect(screen.getByRole('button', { name: 'Reorder milestone 2' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(titles()).toEqual(['A', 'B']);
    expect(screen.getByRole('button', { name: 'Reorder milestone 1' })).toHaveFocus();
  });

  it('does not move a row past either end', async () => {
    const user = userEvent.setup();
    renderSection([milestone({ title: 'A' }), milestone({ title: 'B' })]);
    screen.getByRole('button', { name: 'Reorder milestone 1' }).focus();
    await user.keyboard('{ArrowUp}');
    expect(titles()).toEqual(['A', 'B']);
  });

  it('adds a row from "Add milestone" and focuses it', async () => {
    const user = userEvent.setup();
    renderSection([milestone({ title: 'A' })]);
    await user.click(screen.getByRole('button', { name: 'Add milestone' }));
    expect(titles()).toEqual(['A', '']);
    expect(screen.getByLabelText('Milestone 2 title')).toHaveFocus();
  });

  it('removes a row and disables remove for the last one', async () => {
    const user = userEvent.setup();
    renderSection([milestone({ title: 'A' }), milestone({ title: 'B' })]);
    await user.click(screen.getByRole('button', { name: 'Remove milestone 1' }));
    expect(titles()).toEqual(['B']);
    expect(screen.getByRole('button', { name: 'Remove milestone 1' })).toBeDisabled();
  });

  it('edits a title', async () => {
    const user = userEvent.setup();
    const { latest } = renderSection([milestone({ title: '' })]);
    await user.type(screen.getByLabelText('Milestone 1 title'), 'D');
    expect(latest()[0]?.title).toBe('D');
  });
});

describe('MilestonesSection — expanded detail', () => {
  it('starts collapsed and shows a one-line peek that opens the row', async () => {
    const user = userEvent.setup();
    renderSection([milestone({ title: 'A', descriptionHtml: '<p>Map the pricing rules</p>' })]);
    expect(screen.queryByText('What it covers')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Show details for milestone 1' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(screen.getByRole('button', { name: 'Map the pricing rules' }));

    expect(screen.getByText('What it covers')).toBeInTheDocument();
    expect(screen.getByLabelText('Done when')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide details for milestone 1' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('omits the peek when there is no description', () => {
    renderSection([milestone({ title: 'A' })]);
    expect(
      screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)
    ).toEqual([
      'Reorder milestone 1',
      'Show details for milestone 1',
      'Remove milestone 1',
      'Add milestone',
    ]);
  });

  it('toggles the detail with the chevron and edits the description and done-when', async () => {
    const user = userEvent.setup();
    const { latest } = renderSection([milestone({ title: 'A' })]);
    await user.click(screen.getByRole('button', { name: 'Show details for milestone 1' }));
    await user.type(screen.getByLabelText('What milestone 1 covers'), 'x');
    await user.type(screen.getByLabelText('Done when'), 'y');
    expect(latest()[0]).toMatchObject({ descriptionHtml: 'x', acceptanceCriteria: 'y' });

    await user.click(screen.getByRole('button', { name: 'Hide details for milestone 1' }));
    expect(screen.queryByLabelText('Done when')).not.toBeInTheDocument();
  });
});

describe('MilestonesSection — Fixed pricing', () => {
  it('hides amounts while the switch is off', () => {
    renderSection([milestone({ title: 'A', valueCents: 100_00 })], { pricing: false });
    expect(screen.queryByLabelText('Milestone 1 amount')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows amounts when the switch is on and parses dollars to cents', async () => {
    const user = userEvent.setup();
    const { latest } = renderSection([milestone({ title: 'A' })], { pricing: true });
    await user.type(screen.getByLabelText('Milestone 1 amount'), '9');
    expect(latest()[0]?.valueCents).toBe(900);
  });

  it('calls back with true when the "Price each milestone" switch is turned on', async () => {
    const user = userEvent.setup();
    const { onToggleMilestonePricing } = renderSection([milestone({ title: 'A' })], {
      pricing: false,
    });
    const toggle = screen.getByRole('switch', { name: 'Price each milestone' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    expect(onToggleMilestonePricing).toHaveBeenCalledWith(true);
  });

  it('calls back with false when it is turned off', async () => {
    const user = userEvent.setup();
    const { onToggleMilestonePricing } = renderSection([milestone({ title: 'A' })], {
      pricing: true,
    });
    await user.click(screen.getByRole('switch', { name: 'Price each milestone' }));
    expect(onToggleMilestonePricing).toHaveBeenCalledWith(false);
  });

  it('asks for a project price when none is set', () => {
    renderSection([milestone({ valueCents: 400_000 })], { pricing: true, fixedPriceCents: null });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Milestones add up to A$4,000. Set your project price below.'
    );
  });

  it('confirms when the amounts add up to the price', () => {
    renderSection([milestone({ valueCents: 600_000 }), milestone({ valueCents: 400_000 })], {
      pricing: true,
      fixedPriceCents: 1_000_000,
    });
    expect(screen.getByRole('status')).toHaveTextContent('Adds up to your A$10,000 price');
    expect(screen.queryByRole('button', { name: /set price to/i })).not.toBeInTheDocument();
  });

  it('shows the amount left to assign, without "Set price to" while a row is unpriced', () => {
    renderSection([milestone({ valueCents: 400_000 }), milestone({ valueCents: null })], {
      pricing: true,
      fixedPriceCents: 1_000_000,
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'A$6,000 of your A$10,000 price left to assign'
    );
    expect(screen.queryByRole('button', { name: /set price to/i })).not.toBeInTheDocument();
  });

  it('shows exact cents in the mismatch copy and "Set price to"', () => {
    renderSection([milestone({ valueCents: 400_050 })], {
      pricing: true,
      fixedPriceCents: 1_000_000,
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'A$5,999.50 of your A$10,000 price left to assign'
    );
    expect(screen.getByRole('button', { name: 'Set price to A$4,000.50' })).toBeInTheDocument();
  });

  it('shows the overage and sets the price to the allocated sum', async () => {
    const user = userEvent.setup();
    const { onSetPrice } = renderSection(
      [milestone({ valueCents: 700_000 }), milestone({ valueCents: 500_000 })],
      { pricing: true, fixedPriceCents: 1_000_000 }
    );
    expect(screen.getByRole('status')).toHaveTextContent('A$2,000 over your A$10,000 price');
    await user.click(screen.getByRole('button', { name: 'Set price to A$12,000' }));
    expect(onSetPrice).toHaveBeenCalledWith(1_200_000);
  });

  it('offers "Set price to" when every row is priced but short of the price', async () => {
    const user = userEvent.setup();
    const { onSetPrice } = renderSection([milestone({ valueCents: 400_000 })], {
      pricing: true,
      fixedPriceCents: 1_000_000,
    });
    await user.click(screen.getByRole('button', { name: 'Set price to A$4,000' }));
    expect(onSetPrice).toHaveBeenCalledWith(400_000);
  });

  it('shows no hours field and no estimate under Fixed', () => {
    renderSection([milestone({ title: 'A' })]);
    expect(screen.queryByLabelText('Milestone 1 estimated hours')).not.toBeInTheDocument();
    expect(screen.queryByText(/estimated/)).not.toBeInTheDocument();
  });
});

describe('MilestonesSection — Time & materials', () => {
  it('shows a 0.25-step hours field and no switch or amount', () => {
    renderSection([milestone({ title: 'A', estimatedMinutes: 90 })], { method: 'tm' });
    const hours = screen.getByLabelText('Milestone 1 estimated hours');
    expect(hours).toHaveAttribute('step', '0.25');
    expect(hours).toHaveValue(1.5);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Milestone 1 amount')).not.toBeInTheDocument();
  });

  it('parses hours to integer minutes and clears to null', async () => {
    const user = userEvent.setup();
    const { latest } = renderSection([milestone({ title: 'A' })], { method: 'tm' });
    const hours = screen.getByLabelText('Milestone 1 estimated hours');
    await user.type(hours, '2');
    expect(latest()[0]?.estimatedMinutes).toBe(120);
    await user.clear(hours);
    expect(latest()[0]?.estimatedMinutes).toBeNull();
  });

  it('summarises the hours and the estimated total', () => {
    renderSection([milestone({ estimatedMinutes: 120 }), milestone({ estimatedMinutes: 30 })], {
      method: 'tm',
      totalCents: 40_000,
    });
    expect(screen.getByText('2.5 hours')).toBeInTheDocument();
    expect(screen.getByText('A$400')).toBeInTheDocument();
  });

  it('seeds a 0-minute estimate on rows added under T&M', async () => {
    const user = userEvent.setup();
    const { latest } = renderSection([milestone({ title: 'A', estimatedMinutes: 60 })], {
      method: 'tm',
    });
    await user.click(screen.getByRole('button', { name: 'Add milestone' }));
    expect(latest()[1]).toMatchObject({ valueCents: null, estimatedMinutes: 0 });
  });
});
