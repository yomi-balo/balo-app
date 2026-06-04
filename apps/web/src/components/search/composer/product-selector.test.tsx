import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { ProductTaxonomy } from '@/lib/search/taxonomy';

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => true) };
});

import { ProductSelector } from './product-selector';

const taxonomy: ProductTaxonomy = {
  groups: [
    { id: 'g-ai', name: 'AI', items: [{ id: 'agent', name: 'Agentforce' }] },
    {
      id: 'g-platform',
      name: 'Platform',
      items: [
        { id: 'pl1', name: 'AppExchange' },
        { id: 'pl2', name: 'Heroku' },
        { id: 'pl3', name: 'Hyperforce' },
        { id: 'pl4', name: 'Salesforce Platform' },
        { id: 'pl5', name: 'Security' },
        { id: 'pl6', name: 'Shield' },
      ],
    },
  ],
};

const nameMap = {
  agent: 'Agentforce',
  pl1: 'AppExchange',
  pl2: 'Heroku',
  pl3: 'Hyperforce',
  pl4: 'Salesforce Platform',
  pl5: 'Security',
  pl6: 'Shield',
};

function renderSelector(props: Partial<React.ComponentProps<typeof ProductSelector>> = {}) {
  return render(
    <ProductSelector
      taxonomy={taxonomy}
      selectedIds={new Set()}
      nameMap={nameMap}
      onToggle={vi.fn()}
      onClear={vi.fn()}
      surface="popover"
      {...props}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('ProductSelector', () => {
  it('renders grouped product chips (expanded, non-collapsible)', () => {
    renderSelector();
    expect(screen.getByRole('button', { name: 'Agentforce' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'AppExchange' })).toBeInTheDocument();
  });

  it('caps a dense group to 4 chips and reveals the rest via "+N more"', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSelector();
    // Platform has 6 items → 4 shown + a "2 more" button.
    expect(screen.queryByRole('button', { name: 'Security' })).not.toBeInTheDocument();
    const moreButton = screen.getByRole('button', { name: /2 more/ });
    await user.click(moreButton);
    expect(screen.getByRole('button', { name: 'Security' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Shield' })).toBeInTheDocument();
  });

  it('fires onGroupExpanded with the group name when "+N more" is clicked', async () => {
    const onGroupExpanded = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSelector({ onGroupExpanded });
    await user.click(screen.getByRole('button', { name: /2 more/ }));
    expect(onGroupExpanded).toHaveBeenCalledWith('Platform');
  });

  it('filters across groups when searching and highlights the match', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSelector();
    await user.type(screen.getByRole('textbox', { name: /Search products/i }), 'agent');
    expect(screen.getByRole('button', { name: 'Agentforce' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Heroku' })).not.toBeInTheDocument();
    // The matched substring is wrapped in a highlight mark.
    const mark = document.querySelector('mark');
    expect(mark).not.toBeNull();
    expect(mark!.textContent?.toLowerCase()).toBe('agent');
  });

  it('shows an empty message when nothing matches the search', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSelector();
    await user.type(screen.getByRole('textbox', { name: /Search products/i }), 'zzzz');
    expect(screen.getByText(/No products match/)).toBeInTheDocument();
  });

  it('toggles a product via its chip', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSelector({ onToggle });
    await user.click(screen.getByRole('button', { name: 'Agentforce' }));
    expect(onToggle).toHaveBeenCalledWith('agent');
  });

  it('renders selected tokens and marks the chip pressed', () => {
    renderSelector({ selectedIds: new Set(['agent']) });
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Agentforce' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Agentforce' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('fires product_selector_searched once per typing session (debounced)', async () => {
    const onSearched = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSelector({ onSearched });
    const box = screen.getByRole('textbox', { name: /Search products/i });
    await user.type(box, 'sec');
    vi.advanceTimersByTime(400);
    // Continue typing in the SAME session — must not fire again.
    await user.type(box, 'ur');
    vi.advanceTimersByTime(400);
    expect(onSearched).toHaveBeenCalledTimes(1);
    expect(onSearched).toHaveBeenCalledWith(true);
  });

  it('collapses the browse list but keeps tokens visible (collapsible mode)', async () => {
    const onOpened = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSelector({
      collapsible: true,
      defaultOpen: false,
      surface: 'rail',
      selectedIds: new Set(['agent']),
      onOpened,
    });
    // Browse hidden when collapsed.
    expect(screen.queryByRole('textbox', { name: /Search products/i })).not.toBeInTheDocument();
    // Token still visible.
    expect(screen.getByRole('button', { name: 'Remove Agentforce' })).toBeInTheDocument();
    // Expanding reveals the browse list + fires the opened analytics callback.
    await user.click(screen.getByRole('button', { name: /Products/ }));
    expect(screen.getByRole('textbox', { name: /Search products/i })).toBeInTheDocument();
    expect(onOpened).toHaveBeenCalledWith('rail');
  });
});
