import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
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

describe('TaxonomyMultiSelect', () => {
  it('renders groups + items when populated', () => {
    render(
      <TaxonomyMultiSelect {...BASE} selectedIds={new Set()} onToggle={vi.fn()} onClear={vi.fn()} />
    );
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

  it('filters by search query', async () => {
    const user = userEvent.setup();
    render(
      <TaxonomyMultiSelect {...BASE} selectedIds={new Set()} onToggle={vi.fn()} onClear={vi.fn()} />
    );
    await user.type(screen.getByPlaceholderText('Filter project types…'), 'automation');
    expect(screen.getByRole('button', { name: 'Automation Setup' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'New Salesforce Implementation' })
    ).not.toBeInTheDocument();
  });

  it('shows a no-match message when the search finds nothing', async () => {
    const user = userEvent.setup();
    render(
      <TaxonomyMultiSelect {...BASE} selectedIds={new Set()} onToggle={vi.fn()} onClear={vi.fn()} />
    );
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
