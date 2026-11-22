import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import type { ProposalClauseKind } from '@balo/shared/project-requests';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import {
  CLAUSE_KIND_COPY,
  ClauseListEditor,
  ClauseListHint,
  clauseRemovedToastId,
} from './clause-list-editor';
import { nextDraftKey, type ProposalClauseDraft } from './proposal-composer-state';

vi.mock('sonner', () => ({ toast: vi.fn() }));

const NEW_ROW_ID = 'proposal-clause-new-assumption';

function item(body: string): ProposalClauseDraft {
  return { key: nextDraftKey(), body };
}

function items(...bodies: string[]): ProposalClauseDraft[] {
  return bodies.map(item);
}

interface Options {
  kind?: ProposalClauseKind;
  proposalId?: string | null;
  priceSectionLabel?: string;
}

interface Rendered {
  /** The bodies currently held by the (controlled) editor, in order. */
  bodies: () => string[];
  keys: () => string[];
}

/** A stateful parent: the editor is controlled, so Enter/Backspace/reorder need one to apply `onChange`. */
function renderEditor(initial: ProposalClauseDraft[], options: Options = {}): Rendered {
  const {
    kind = 'assumption',
    proposalId = 'p1',
    priceSectionLabel = 'Price and payments',
  } = options;
  let current = initial;
  function Harness(): React.JSX.Element {
    const [list, setList] = useState(initial);
    current = list;
    return (
      <ClauseListEditor
        kind={kind}
        items={list}
        onChange={setList}
        proposalId={proposalId}
        companyName="Northwind"
        priceSectionLabel={priceSectionLabel}
        newRowId={NEW_ROW_ID}
      />
    );
  }
  render(<Harness />);
  return { bodies: () => current.map((c) => c.body), keys: () => current.map((c) => c.key) };
}

function box(label: string): HTMLTextAreaElement {
  const element = screen.getByLabelText(label);
  if (!(element instanceof HTMLTextAreaElement)) throw new Error(`${label} is not a textarea`);
  return element;
}

const mockTrack = vi.mocked(track);
const mockToast = vi.mocked(toast);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ClauseListEditor — rows', () => {
  it('numbers each item, labelling its textarea, grip and remove button', () => {
    renderEditor(items('Sandbox by kickoff', 'Final price list'));

    expect(box('assumption 1')).toHaveValue('Sandbox by kickoff');
    expect(box('assumption 2')).toHaveValue('Final price list');
    expect(
      screen.getByRole('button', {
        name: 'Reorder assumption 1. Use the up and down arrow keys.',
      })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove assumption 2' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('caps every textarea at 500 characters', () => {
    renderEditor(items('A'));
    expect(box('assumption 1')).toHaveAttribute('maxLength', '500');
    expect(box('Add an assumption')).toHaveAttribute('maxLength', '500');
  });

  it.each([
    ['assumption', 'Add an assumption', 'assumption 1', 'Remove assumption 1'],
    ['exclusion', 'Add an exclusion', 'exclusion 1', 'Remove exclusion 1'],
    ['additional_term', 'Add a term', 'term 1', 'Remove term 1'],
  ] as const)('uses the %s copy', (kind, addLabel, itemLabel, removeLabel) => {
    renderEditor(items('A'), { kind });
    expect(box(addLabel)).toBeInTheDocument();
    expect(box(itemLabel)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: removeLabel })).toBeInTheDocument();
  });

  it.each([
    ['assumption', 'For example: Northwind gives us sandbox access by kickoff'],
    ['exclusion', 'For example: Migrating historical quotes from your spreadsheets'],
    ['additional_term', 'For example: One round of revisions is included per milestone'],
  ] as const)('shows the %s example in the empty row while the list is empty', (kind, example) => {
    renderEditor([], { kind });
    expect(screen.getByPlaceholderText(example)).toBe(box(CLAUSE_KIND_COPY[kind].add));
  });

  it('swaps the example for the add label once the list has an item', () => {
    renderEditor(items('A'));
    expect(box('Add an assumption')).toHaveAttribute('placeholder', 'Add an assumption');
  });

  it('puts the empty row’s textarea id in a flash box, for the checklist jump', () => {
    renderEditor([]);
    const ghost = document.getElementById(NEW_ROW_ID);
    expect(ghost).toBe(box('Add an assumption'));
    expect(ghost?.closest('[data-flash]')).not.toBeNull();
  });

  it('turns typed line breaks into a space and holds the 500 cap', () => {
    const state = renderEditor(items('A'));
    fireEvent.change(box('assumption 1'), { target: { value: 'one\n\ntwo' } });
    expect(state.bodies()).toEqual(['one two']);

    fireEvent.change(box('assumption 1'), { target: { value: 'x'.repeat(600) } });
    expect(state.bodies()[0]).toHaveLength(500);
  });

  it('turns a Shift+Enter line break into a space', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('A'));

    await user.type(box('assumption 1'), '{Shift>}{Enter}{/Shift}B');

    expect(state.bodies()).toEqual(['A B']);
  });

  it('grows the textarea to its content height', () => {
    renderEditor(items('A'));
    const area = box('assumption 1');
    Object.defineProperty(area, 'scrollHeight', { configurable: true, value: 88 });

    fireEvent.change(area, { target: { value: 'A much longer line' } });

    expect(area.style.height).toBe('88px');
  });
});

describe('ClauseListEditor — the empty row', () => {
  it('Enter commits the text, clears the row and keeps focus there', async () => {
    const user = userEvent.setup();
    const state = renderEditor([]);
    const ghost = box('Add an assumption');

    await user.type(ghost, 'First one{Enter}');

    expect(state.bodies()).toEqual(['First one']);
    expect(box('Add an assumption')).toHaveValue('');
    expect(box('Add an assumption')).toHaveFocus();

    await user.type(box('Add an assumption'), 'Second{Enter}');
    expect(state.bodies()).toEqual(['First one', 'Second']);
  });

  it('Enter on a blank row adds nothing', async () => {
    const user = userEvent.setup();
    const state = renderEditor([]);

    await user.type(box('Add an assumption'), '   {Enter}');

    expect(state.bodies()).toEqual([]);
  });

  it('Shift+Enter does not commit', async () => {
    const user = userEvent.setup();
    const state = renderEditor([]);

    await user.type(box('Add an assumption'), 'Draft{Shift>}{Enter}{/Shift}');

    expect(state.bodies()).toEqual([]);
  });

  it('blur commits non-blank text', async () => {
    const user = userEvent.setup();
    const state = renderEditor([]);

    await user.type(box('Add an assumption'), 'Left unfinished');
    await user.tab();

    expect(state.bodies()).toEqual(['Left unfinished']);
    expect(box('Add an assumption')).toHaveValue('');
  });

  it('blur with blank text adds nothing', async () => {
    const user = userEvent.setup();
    const state = renderEditor([]);

    await user.type(box('Add an assumption'), '   ');
    await user.tab();

    expect(state.bodies()).toEqual([]);
  });

  it('Backspace on an empty row focuses the last item', async () => {
    const user = userEvent.setup();
    renderEditor(items('A', 'B'));

    await user.click(box('Add an assumption'));
    await user.keyboard('{Backspace}');

    expect(box('assumption 2')).toHaveFocus();
  });

  it('Backspace on a non-empty row just deletes a character', async () => {
    const user = userEvent.setup();
    renderEditor(items('A'));

    await user.type(box('Add an assumption'), 'ab{Backspace}');

    expect(box('Add an assumption')).toHaveValue('a');
    expect(box('Add an assumption')).toHaveFocus();
  });

  it('Backspace on an empty row of an empty list does nothing', async () => {
    const user = userEvent.setup();
    renderEditor([]);

    await user.click(box('Add an assumption'));
    await user.keyboard('{Backspace}');

    expect(box('Add an assumption')).toHaveFocus();
  });

  it('ignores Enter during IME composition', () => {
    const state = renderEditor([]);
    const ghost = box('Add an assumption');
    fireEvent.change(ghost, { target: { value: 'にほん' } });

    fireEvent.keyDown(ghost, { key: 'Enter', isComposing: true });

    expect(state.bodies()).toEqual([]);
    expect(ghost).toHaveValue('にほん');
  });
});

describe('ClauseListEditor — keys in an item', () => {
  it('Enter on a middle item with text inserts a blank item after it and focuses it', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('A', 'B'));

    await user.click(box('assumption 1'));
    await user.keyboard('{Enter}');

    expect(state.bodies()).toEqual(['A', '', 'B']);
    expect(box('assumption 2')).toHaveFocus();
  });

  it('Enter on the last item focuses the empty row instead', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('A', 'B'));

    await user.click(box('assumption 2'));
    await user.keyboard('{Enter}');

    expect(state.bodies()).toEqual(['A', 'B']);
    expect(box('Add an assumption')).toHaveFocus();
  });

  it('Enter on a blank item does nothing', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('A', ''));

    await user.click(box('assumption 2'));
    await user.keyboard('{Enter}');

    expect(state.bodies()).toEqual(['A', '']);
    expect(box('assumption 2')).toHaveFocus();
  });

  it('Backspace on an empty item removes it and focuses the previous one', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('A', 'B', ''));

    await user.click(box('assumption 3'));
    await user.keyboard('{Backspace}');

    expect(state.bodies()).toEqual(['A', 'B']);
    expect(box('assumption 2')).toHaveFocus();
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('Backspace on an empty first item focuses the item that takes its place', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('', 'B'));

    await user.click(box('assumption 1'));
    await user.keyboard('{Backspace}');

    expect(state.bodies()).toEqual(['B']);
    expect(box('assumption 1')).toHaveFocus();
  });

  it('Backspace on the only item focuses the empty row', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items(''));

    await user.click(box('assumption 1'));
    await user.keyboard('{Backspace}');

    expect(state.bodies()).toEqual([]);
    expect(box('Add an assumption')).toHaveFocus();
  });

  it('Backspace on an item with text edits it', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('AB'));

    await user.type(box('assumption 1'), '{Backspace}');

    expect(state.bodies()).toEqual(['A']);
  });

  it('blur on a blank item removes it, with no Undo', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('A', ''));

    await user.click(box('assumption 2'));
    await user.tab();

    expect(state.bodies()).toEqual(['A']);
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('blur on an item with text keeps it', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('A', 'B'));

    await user.click(box('assumption 1'));
    await user.tab();

    expect(state.bodies()).toEqual(['A', 'B']);
  });

  it('ignores Enter during IME composition', () => {
    const state = renderEditor(items('A', 'B'));

    fireEvent.keyDown(box('assumption 1'), { key: 'Enter', isComposing: true });

    expect(state.bodies()).toEqual(['A', 'B']);
  });
});

describe('ClauseListEditor — paste', () => {
  it('splices one item per line in at the cursor, stripping list markers', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('A', 'B'));

    await user.click(box('assumption 1'));
    await user.paste('- One\n2. Two\n• Three');

    expect(state.bodies()).toEqual(['AOne', 'Two', 'Three', 'B']);
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROPOSAL_CLAUSES_PASTED, {
      proposal_id: 'p1',
      kind: 'assumption',
      line_count: 3,
    });
  });

  it('keeps the typed text: the first line joins it and the last becomes the next item', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('Alpha'));

    await user.click(box('assumption 1'));
    box('assumption 1').setSelectionRange(5, 5);
    await user.paste('one\ntwo');

    expect(state.bodies()).toEqual(['Alphaone', 'two']);
  });

  it('joins the text after the cursor onto the last pasted line', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('AlphaOmega', 'B'));

    await user.click(box('assumption 1'));
    box('assumption 1').setSelectionRange(5, 5);
    await user.paste('one\nmiddle\ntwo');

    expect(state.bodies()).toEqual(['Alphaone', 'middle', 'twoOmega', 'B']);
  });

  it('replaces the selected text with the pasted lines', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('Keep DROP tail'));

    await user.click(box('assumption 1'));
    box('assumption 1').setSelectionRange(5, 9);
    await user.paste('one\ntwo');

    expect(state.bodies()).toEqual(['Keep one', 'two tail']);
  });

  it('keeps the text typed in the empty row ahead of the pasted lines', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('A'));

    await user.type(box('Add an assumption'), 'Typed ');
    await user.paste('one\ntwo');

    expect(state.bodies()).toEqual(['A', 'Typed one', 'two']);
    expect(box('Add an assumption')).toHaveValue('');
  });

  it('caps a joined line at 500 characters', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('x'.repeat(499)));

    await user.click(box('assumption 1'));
    await user.paste('one\ntwo');

    expect(state.bodies()[0]).toHaveLength(500);
    expect(state.bodies()[1]).toBe('two');
  });

  it('appends the lines pasted into the empty row, and clears it', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('A'), { kind: 'exclusion' });

    await user.click(box('Add an exclusion'));
    await user.paste('X\r\nY');

    expect(state.bodies()).toEqual(['A', 'X', 'Y']);
    expect(box('Add an exclusion')).toHaveValue('');
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROPOSAL_CLAUSES_PASTED, {
      proposal_id: 'p1',
      kind: 'exclusion',
      line_count: 2,
    });
  });

  it('drops blank lines from a pasted list', async () => {
    const user = userEvent.setup();
    const state = renderEditor([]);

    await user.click(box('Add an assumption'));
    await user.paste('One\n\n   \nTwo\n');

    expect(state.bodies()).toEqual(['One', 'Two']);
  });

  it('pastes a single line as ordinary text and fires nothing', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('A'));

    await user.click(box('assumption 1'));
    await user.paste(' plus more');

    expect(state.bodies()).toEqual(['A plus more']);
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('keeps the lines that fit and toasts how many were added when a paste overflows', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items(...Array.from({ length: 18 }, (_, i) => `Existing ${i + 1}`)));

    await user.click(box('Add an assumption'));
    await user.paste('P1\nP2\nP3\nP4\nP5');

    expect(state.bodies()).toHaveLength(20);
    expect(state.bodies().slice(18)).toEqual(['P1', 'P2']);
    expect(mockToast).toHaveBeenCalledWith('Added 2 of 5. A list holds up to 20.');
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROPOSAL_CLAUSES_PASTED, {
      proposal_id: 'p1',
      kind: 'assumption',
      line_count: 5,
    });
  });

  it('does not toast when every pasted line fits', async () => {
    const user = userEvent.setup();
    renderEditor([]);

    await user.click(box('Add an assumption'));
    await user.paste('One\nTwo');

    expect(mockToast).not.toHaveBeenCalled();
  });

  it('still adds the lines, but fires no event, before the first save', async () => {
    const user = userEvent.setup();
    const state = renderEditor([], { proposalId: null });

    await user.click(box('Add an assumption'));
    await user.paste('One\nTwo');

    expect(state.bodies()).toEqual(['One', 'Two']);
    expect(mockTrack).not.toHaveBeenCalled();
  });
});

describe('ClauseListEditor — reorder', () => {
  function grip(n: number): HTMLElement {
    return screen.getByRole('button', {
      name: `Reorder assumption ${n}. Use the up and down arrow keys.`,
    });
  }

  it('ArrowDown on the grip swaps the item with the next one and keeps focus on that grip', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('A', 'B', 'C'));
    const movedKey = state.keys()[0];

    act(() => grip(1).focus());
    await user.keyboard('{ArrowDown}');

    expect(state.bodies()).toEqual(['B', 'A', 'C']);
    expect(grip(2)).toHaveFocus();
    expect(grip(2).id).toBe(`proposal-clause-grip-assumption-${movedKey}`);
    expect(screen.getByText('Moved assumption 1 to position 2 of 3')).toBeInTheDocument();
  });

  it('ArrowUp swaps with the previous item', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('A', 'B', 'C'));

    act(() => grip(3).focus());
    await user.keyboard('{ArrowUp}');

    expect(state.bodies()).toEqual(['A', 'C', 'B']);
    expect(grip(2)).toHaveFocus();
  });

  it('does nothing at either end of the list', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('A', 'B'));

    act(() => grip(1).focus());
    await user.keyboard('{ArrowUp}');
    act(() => grip(2).focus());
    await user.keyboard('{ArrowDown}');

    expect(state.bodies()).toEqual(['A', 'B']);
  });

  it('ignores other keys on the grip', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('A', 'B'));

    act(() => grip(1).focus());
    await user.keyboard('{ArrowRight}x');

    expect(state.bodies()).toEqual(['A', 'B']);
  });

  it('starts a drag from a pointer press on the grip', () => {
    renderEditor(items('A', 'B'));
    expect(() => fireEvent.pointerDown(grip(1))).not.toThrow();
  });

  it('labels the grip with the kind’s noun', () => {
    renderEditor(items('A'), { kind: 'additional_term' });
    expect(
      screen.getByRole('button', { name: 'Reorder term 1. Use the up and down arrow keys.' })
    ).toBeInTheDocument();
  });
});

describe('ClauseListEditor — counter', () => {
  it('shows no counter below 420 characters', () => {
    renderEditor(items('x'.repeat(419)));
    expect(screen.queryByText(/\/ 500/)).not.toBeInTheDocument();
  });

  it('shows the counter from 420 characters, in a muted tone', () => {
    renderEditor(items('x'.repeat(420)));
    const counter = screen.getByText('420 / 500');
    expect(counter).toHaveClass('text-muted-foreground');
    expect(counter).not.toHaveClass('text-destructive');
  });

  it('turns destructive at 500', () => {
    renderEditor(items('x'.repeat(500)));
    expect(screen.getByText('500 / 500')).toHaveClass('text-destructive');
  });

  it('appears as the text grows past 420', () => {
    renderEditor(items('x'));
    expect(screen.queryByText(/\/ 500/)).not.toBeInTheDocument();
    fireEvent.change(box('assumption 1'), { target: { value: 'x'.repeat(430) } });
    expect(screen.getByText('430 / 500')).toBeInTheDocument();
  });
});

describe('ClauseListEditor — a full list', () => {
  const full = (): ProposalClauseDraft[] =>
    items(...Array.from({ length: 20 }, (_, i) => `Item ${i + 1}`));

  it('replaces the empty row with the "most a list holds" line', () => {
    renderEditor(full());
    expect(
      screen.getByText('That’s 20, the most a list holds. Combine related points to add another.')
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Add an assumption')).not.toBeInTheDocument();
    expect(document.getElementById(NEW_ROW_ID)).toBeNull();
  });

  it('keeps the empty row at 19 items, and closes it when the 20th lands', async () => {
    const user = userEvent.setup();
    const state = renderEditor(full().slice(0, 19));

    await user.type(box('Add an assumption'), 'Twentieth{Enter}');

    expect(state.bodies()).toHaveLength(20);
    expect(screen.queryByLabelText('Add an assumption')).not.toBeInTheDocument();
  });

  it('moves focus to the last item and announces the cap when the 20th item lands', async () => {
    const user = userEvent.setup();
    renderEditor(full().slice(0, 19));
    const live = document.querySelector('[aria-live="polite"]');
    expect(live).toHaveTextContent('');

    await user.type(box('Add an assumption'), 'Twentieth{Enter}');

    expect(box('assumption 20')).toHaveFocus();
    expect(live).toHaveTextContent(
      'That’s 20, the most a list holds. Combine related points to add another.'
    );
  });

  it('Enter on the last item of a full list does not look for the missing row', async () => {
    const user = userEvent.setup();
    const state = renderEditor(full());

    await user.click(box('assumption 20'));
    await user.keyboard('{Enter}');

    expect(state.bodies()).toHaveLength(20);
    expect(box('assumption 20')).toHaveFocus();
  });

  it('Enter on a middle item of a full list adds no 21st item', async () => {
    const user = userEvent.setup();
    const state = renderEditor(full());

    await user.click(box('assumption 1'));
    await user.keyboard('{Enter}');

    expect(state.bodies()).toHaveLength(20);
  });

  it('pasting into a full list adds no item and says how many lines fit', async () => {
    const user = userEvent.setup();
    const state = renderEditor(full());

    await user.click(box('assumption 1'));
    await user.paste('Extra 1\nExtra 2');

    expect(state.bodies()).toHaveLength(20);
    expect(mockToast).toHaveBeenCalledWith('Added 1 of 2. A list holds up to 20.');
  });

  it('opens the empty row again once an item is removed', async () => {
    const user = userEvent.setup();
    renderEditor(full());

    await user.click(screen.getByRole('button', { name: 'Remove assumption 20' }));

    expect(screen.getByLabelText('Add an assumption')).toBeInTheDocument();
  });
});

describe('ClauseListEditor — remove and Undo', () => {
  function lastUndo(): () => void {
    const call = mockToast.mock.calls.at(-1);
    const options = call?.[1] as { action?: { onClick?: () => void } } | undefined;
    const onClick = options?.action?.onClick;
    if (onClick === undefined) throw new Error('expected a toast with an Undo action');
    return onClick;
  }

  it('removes an item and offers Undo when it had text', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('A', 'B', 'C'));

    await user.click(screen.getByRole('button', { name: 'Remove assumption 2' }));

    expect(state.bodies()).toEqual(['A', 'C']);
    expect(mockToast).toHaveBeenCalledWith(
      'Assumption removed',
      expect.objectContaining({
        id: clauseRemovedToastId('assumption'),
        action: expect.objectContaining({ label: 'Undo' }),
      })
    );
  });

  it('Undo puts the item back where it was', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('A', 'B', 'C'));

    await user.click(screen.getByRole('button', { name: 'Remove assumption 2' }));
    const undo = lastUndo();
    act(() => undo());

    expect(state.bodies()).toEqual(['A', 'B', 'C']);
  });

  it('Undo after later edits keeps them', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('A', 'B', 'C'));

    await user.click(screen.getByRole('button', { name: 'Remove assumption 2' }));
    const undo = lastUndo();
    fireEvent.change(box('assumption 1'), { target: { value: 'A, edited' } });
    act(() => undo());

    expect(state.bodies()).toEqual(['A, edited', 'B', 'C']);
  });

  it('Undo twice does not duplicate the item', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('A', 'B'));

    await user.click(screen.getByRole('button', { name: 'Remove assumption 1' }));
    const undo = lastUndo();
    act(() => undo());
    act(() => undo());

    expect(state.bodies()).toEqual(['A', 'B']);
  });

  it('Undo is a no-op when the list has filled up again', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items(...Array.from({ length: 20 }, (_, i) => `Item ${i + 1}`)));

    await user.click(screen.getByRole('button', { name: 'Remove assumption 1' }));
    const undo = lastUndo();
    await user.type(box('Add an assumption'), 'Replacement{Enter}');
    act(() => undo());

    expect(state.bodies()).toHaveLength(20);
    expect(state.bodies()).not.toContain('Item 1');
  });

  it('removes a blank item without an Undo', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('A', '  '));

    await user.click(screen.getByRole('button', { name: 'Remove assumption 2' }));

    expect(state.bodies()).toEqual(['A']);
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('moves focus to the previous item after a remove', async () => {
    const user = userEvent.setup();
    renderEditor(items('A', 'B'));

    await user.click(screen.getByRole('button', { name: 'Remove assumption 2' }));

    expect(box('assumption 1')).toHaveFocus();
  });

  it('uses the kind’s own removed copy', async () => {
    const user = userEvent.setup();
    renderEditor(items('A'), { kind: 'additional_term' });

    await user.click(screen.getByRole('button', { name: 'Remove term 1' }));

    expect(mockToast).toHaveBeenCalledWith('Term removed', expect.anything());
  });
});

describe('ClauseListEditor — amount warning', () => {
  it('warns under an item that names an amount, naming the company and the price section', () => {
    renderEditor(items('Capped at $5,000', 'Two rounds of revisions'));

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(
      'Northwind would see this amount exactly as typed, without Balo’s margin. Keep prices in Price and payments.'
    );
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('names the T&M price section', () => {
    renderEditor(items('Billed at $200/hr'), { priceSectionLabel: 'Rates and billing' });
    expect(screen.getByRole('status')).toHaveTextContent('Keep prices in Rates and billing.');
  });

  it('never blocks anything: the warned item stays editable', async () => {
    const user = userEvent.setup();
    const state = renderEditor(items('A'));

    await user.type(box('assumption 1'), ' costs $500');

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(state.bodies()).toEqual(['A costs $500']);
  });

  it('shows no warning for text without an amount', () => {
    renderEditor(items('Two rounds of revisions', 'Phase 2'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('fires the warning event once per item, however much more is typed', async () => {
    const user = userEvent.setup();
    renderEditor(items('A'), { kind: 'exclusion' });

    await user.type(box('exclusion 1'), ' at $500');
    await user.type(box('exclusion 1'), ' per day, every day');

    const warned = mockTrack.mock.calls.filter(
      ([event]) => event === PROJECT_EVENTS.PROPOSAL_CLAUSE_AMOUNT_WARNING_SHOWN
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]?.[1]).toEqual({ proposal_id: 'p1', kind: 'exclusion' });
  });

  it('fires once for each warned item', () => {
    renderEditor(items('$100 upfront', 'Billed at A$50/hr', 'No amount here'));

    expect(
      mockTrack.mock.calls.filter(
        ([event]) => event === PROJECT_EVENTS.PROPOSAL_CLAUSE_AMOUNT_WARNING_SHOWN
      )
    ).toHaveLength(2);
  });

  it('does not fire again when an item is moved, and fires for a newly added item', async () => {
    const user = userEvent.setup();
    renderEditor(items('$100 upfront', 'B'));
    const count = (): number =>
      mockTrack.mock.calls.filter(
        ([event]) => event === PROJECT_EVENTS.PROPOSAL_CLAUSE_AMOUNT_WARNING_SHOWN
      ).length;
    expect(count()).toBe(1);

    act(() =>
      screen
        .getByRole('button', { name: 'Reorder assumption 1. Use the up and down arrow keys.' })
        .focus()
    );
    await user.keyboard('{ArrowDown}');
    expect(count()).toBe(1);

    await user.type(box('Add an assumption'), 'Extra $20 fee{Enter}');
    expect(count()).toBe(2);
  });

  it('shows the warning but fires no event before the first save', () => {
    renderEditor(items('$100 upfront'), { proposalId: null });
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(mockTrack).not.toHaveBeenCalled();
  });
});

describe('ClauseListHint', () => {
  it('reads the keyboard hint and is visible only while the section has focus', () => {
    render(<ClauseListHint />);
    const hint = screen.getByText('Enter adds the next. Paste a list to add one per line.');
    expect(hint).toHaveClass('invisible', 'group-focus-within/clauses:visible');
  });
});
