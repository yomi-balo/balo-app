import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { TaxonomyMultiSelect } from './taxonomy-multi-select';
import type { ProductTaxonomy } from '@/lib/search/taxonomy';

const TAXONOMY: ProductTaxonomy = {
  groups: [
    {
      id: 'g1',
      name: 'Foundational',
      items: [
        { id: 'a', name: 'New Salesforce Implementation' },
        { id: 'b', name: 'Data Migration' },
      ],
    },
    {
      id: 'g2',
      name: 'Optimization',
      items: [{ id: 'c', name: 'Automation Setup' }],
    },
  ],
};

const NAME_MAP = {
  a: 'New Salesforce Implementation',
  b: 'Data Migration',
  c: 'Automation Setup',
};

const BASE = {
  taxonomy: TAXONOMY,
  nameMap: NAME_MAP,
  fieldId: 'tags',
  searchPlaceholder: 'Filter project types…',
  emptyCopy: "Project types couldn't load right now.",
  errorCopy: 'Couldn’t load project types. You can still send your request.',
  noMatchNoun: 'project types',
} as const;

/** Click the search control to reveal the (overlay) browse popup. */
async function openBrowse(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByPlaceholderText('Filter project types…'));
}

describe('TaxonomyMultiSelect', () => {
  it('does not render the browse tree at rest, but shows the search control', () => {
    render(
      <TaxonomyMultiSelect {...BASE} selectedIds={new Set()} onToggle={vi.fn()} onClear={vi.fn()} />
    );
    expect(screen.queryByTestId('taxonomy-browse-tags')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Filter project types…')).toBeInTheDocument();
  });

  it('opens the overlay on focus/click of the search control', async () => {
    const user = userEvent.setup();
    render(
      <TaxonomyMultiSelect {...BASE} selectedIds={new Set()} onToggle={vi.fn()} onClear={vi.fn()} />
    );
    await openBrowse(user);
    expect(screen.getByTestId('taxonomy-browse-tags')).toBeInTheDocument();
  });

  it('renders the browse popup as an absolutely positioned overlay', async () => {
    const user = userEvent.setup();
    render(
      <TaxonomyMultiSelect {...BASE} selectedIds={new Set()} onToggle={vi.fn()} onClear={vi.fn()} />
    );
    await openBrowse(user);
    expect(screen.getByTestId('taxonomy-browse-tags').className).toContain('absolute');
  });

  it('places the search control before the selected band in DOM order', () => {
    render(
      <TaxonomyMultiSelect
        {...BASE}
        selectedIds={new Set(['a'])}
        onToggle={vi.fn()}
        onClear={vi.fn()}
      />
    );
    const input = screen.getByPlaceholderText('Filter project types…');
    const band = screen.getByText('1 selected');
    // input precedes band ⇒ band FOLLOWS input.
    expect(input.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('closes the overlay on Escape', async () => {
    const user = userEvent.setup();
    render(
      <TaxonomyMultiSelect {...BASE} selectedIds={new Set()} onToggle={vi.fn()} onClear={vi.fn()} />
    );
    await openBrowse(user);
    expect(screen.getByTestId('taxonomy-browse-tags')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('taxonomy-browse-tags')).not.toBeInTheDocument();
  });

  it('closes the overlay on outside mousedown', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">outside</button>
        <TaxonomyMultiSelect
          {...BASE}
          selectedIds={new Set()}
          onToggle={vi.fn()}
          onClear={vi.fn()}
        />
      </div>
    );
    await openBrowse(user);
    expect(screen.getByTestId('taxonomy-browse-tags')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByTestId('taxonomy-browse-tags')).not.toBeInTheDocument();
  });

  it('closes the overlay when focus leaves the field (blur)', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <TaxonomyMultiSelect
          {...BASE}
          selectedIds={new Set()}
          onToggle={vi.fn()}
          onClear={vi.fn()}
        />
        <button type="button">after</button>
      </div>
    );
    await openBrowse(user);
    expect(screen.getByTestId('taxonomy-browse-tags')).toBeInTheDocument();
    const input = screen.getByPlaceholderText('Filter project types…');
    const after = screen.getByRole('button', { name: 'after' });
    // Focus moves out of the field entirely (e.g. Tab to the next section).
    fireEvent.focusOut(input, { relatedTarget: after });
    expect(screen.queryByTestId('taxonomy-browse-tags')).not.toBeInTheDocument();
  });

  it('keeps the overlay open while focus stays within the field', async () => {
    const user = userEvent.setup();
    render(
      <TaxonomyMultiSelect {...BASE} selectedIds={new Set()} onToggle={vi.fn()} onClear={vi.fn()} />
    );
    await openBrowse(user);
    const input = screen.getByPlaceholderText('Filter project types…');
    const chip = screen.getByRole('button', { name: 'Data Migration' });
    // Focus shifts from the input to a chip inside the same field — must NOT close.
    fireEvent.focusOut(input, { relatedTarget: chip });
    expect(screen.getByTestId('taxonomy-browse-tags')).toBeInTheDocument();
  });

  it('toggles the overlay via the chevron button and reflects aria-expanded', async () => {
    const user = userEvent.setup();
    render(
      <TaxonomyMultiSelect {...BASE} selectedIds={new Set()} onToggle={vi.fn()} onClear={vi.fn()} />
    );
    const toggle = screen.getByRole('button', { name: 'Show options' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(screen.getByTestId('taxonomy-browse-tags')).toBeInTheDocument();
    const close = screen.getByRole('button', { name: 'Hide options' });
    expect(close).toHaveAttribute('aria-expanded', 'true');
    await user.click(close);
    expect(screen.queryByTestId('taxonomy-browse-tags')).not.toBeInTheDocument();
  });

  it('exposes the browse popup as a labelled group', async () => {
    const user = userEvent.setup();
    render(
      <TaxonomyMultiSelect {...BASE} selectedIds={new Set()} onToggle={vi.fn()} onClear={vi.fn()} />
    );
    await openBrowse(user);
    expect(screen.getByRole('group', { name: 'Browse project types' })).toBeInTheDocument();
  });

  it('renders groups + items in the popup when populated', async () => {
    const user = userEvent.setup();
    render(
      <TaxonomyMultiSelect {...BASE} selectedIds={new Set()} onToggle={vi.fn()} onClear={vi.fn()} />
    );
    await openBrowse(user);
    expect(screen.getByText('Foundational')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'New Salesforce Implementation' })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Automation Setup' })).toBeInTheDocument();
  });

  it('toggles an item via onToggle', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <TaxonomyMultiSelect
        {...BASE}
        selectedIds={new Set()}
        onToggle={onToggle}
        onClear={vi.fn()}
      />
    );
    await openBrowse(user);
    await user.click(screen.getByRole('button', { name: 'Data Migration' }));
    expect(onToggle).toHaveBeenCalledWith('b');
  });

  it('shows the selected tray with Clear all', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    render(
      <TaxonomyMultiSelect
        {...BASE}
        selectedIds={new Set(['a', 'c'])}
        onToggle={vi.fn()}
        onClear={onClear}
      />
    );
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /clear all/i }));
    expect(onClear).toHaveBeenCalled();
  });

  it('shows the category line on multi-group pills, including self-titled items', () => {
    const taxonomy: ProductTaxonomy = {
      groups: [
        { id: 'svc', name: 'Service Cloud', items: [{ id: 's', name: 'Service Cloud' }] },
        { id: 'sales', name: 'Sales Cloud', items: [{ id: 'q', name: 'CPQ' }] },
      ],
    };
    render(
      <TaxonomyMultiSelect
        {...BASE}
        taxonomy={taxonomy}
        nameMap={{ s: 'Service Cloud', q: 'CPQ' }}
        selectedIds={new Set(['s'])}
        onToggle={vi.fn()}
        onClear={vi.fn()}
      />
    );
    // Self-titled item: both the category line and the name render (not de-duped).
    expect(screen.getAllByText('Service Cloud')).toHaveLength(2);
  });

  it('hides popup group labels and renders name-only pills for a single-group taxonomy', async () => {
    const user = userEvent.setup();
    const taxonomy: ProductTaxonomy = {
      groups: [
        {
          id: 'only',
          name: 'Engagement model',
          items: [
            { id: 'p', name: 'Project (scoped)' },
            { id: 'k', name: 'Package (productized)' },
          ],
        },
      ],
    };
    render(
      <TaxonomyMultiSelect
        {...BASE}
        taxonomy={taxonomy}
        nameMap={{ p: 'Project (scoped)', k: 'Package (productized)' }}
        selectedIds={new Set(['p'])}
        onToggle={vi.fn()}
        onClear={vi.fn()}
      />
    );
    // Pill: name only, no category line for the single-group flat path.
    expect(screen.getByText('Project (scoped)')).toBeInTheDocument();
    expect(screen.queryByText('Engagement model')).not.toBeInTheDocument();
    // Popup: no group label row.
    await openBrowse(user);
    expect(screen.queryByText('Engagement model')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Package (productized)' })).toBeInTheDocument();
  });

  it('filters by search query', async () => {
    const user = userEvent.setup();
    render(
      <TaxonomyMultiSelect {...BASE} selectedIds={new Set()} onToggle={vi.fn()} onClear={vi.fn()} />
    );
    await openBrowse(user);
    await user.type(screen.getByPlaceholderText('Filter project types…'), 'automation');
    expect(screen.getByRole('button', { name: 'Automation Setup' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'New Salesforce Implementation' })
    ).not.toBeInTheDocument();
  });

  it('keeps a group whose name matches even when no item name matches', async () => {
    const user = userEvent.setup();
    render(
      <TaxonomyMultiSelect {...BASE} selectedIds={new Set()} onToggle={vi.fn()} onClear={vi.fn()} />
    );
    await openBrowse(user);
    // "Optimization" is a group name, not an item name — group-name match keeps
    // the group header (existing behaviour) even though its item is filtered out.
    await user.type(screen.getByPlaceholderText('Filter project types…'), 'optimization');
    expect(screen.getByText('Optimization')).toBeInTheDocument();
    expect(screen.queryByText(/no project types match/i)).not.toBeInTheDocument();
  });

  it('shows a no-match message when the search finds nothing', async () => {
    const user = userEvent.setup();
    render(
      <TaxonomyMultiSelect {...BASE} selectedIds={new Set()} onToggle={vi.fn()} onClear={vi.fn()} />
    );
    await openBrowse(user);
    await user.type(screen.getByPlaceholderText('Filter project types…'), 'zzzzz');
    expect(screen.getByText(/no project types match/i)).toBeInTheDocument();
  });

  it('renders the loading skeleton', () => {
    render(
      <TaxonomyMultiSelect
        {...BASE}
        taxonomy={{ groups: [] }}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        onClear={vi.fn()}
        loading
      />
    );
    expect(screen.getByText(/loading options/i)).toBeInTheDocument();
  });

  it('renders the empty panel + Retry when no groups and not errored', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <TaxonomyMultiSelect
        {...BASE}
        taxonomy={{ groups: [] }}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        onClear={vi.fn()}
        onRetry={onRetry}
      />
    );
    expect(screen.getByText("Project types couldn't load right now.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('renders the error copy when errored', () => {
    render(
      <TaxonomyMultiSelect
        {...BASE}
        taxonomy={{ groups: [] }}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        onClear={vi.fn()}
        error
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByText(/you can still send your request/i)).toBeInTheDocument();
  });
});
