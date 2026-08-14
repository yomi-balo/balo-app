import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import type { ActionItemNodeView } from '@/lib/engagement/action-items-view';
import type { CaseActionItemsView } from '@/lib/cases/case-view-types';
import { CaseActionItems } from './case-action-items';

/**
 * BAL-421 — the rail's action-items card: three LENS-RELATIVE buckets over one read-only view.
 *
 * ⚠⚠ THE UNASSIGNED GROUP RENDERS EVEN WHEN THE OTHER TWO ARE EMPTY, and that is the assertion
 * this file exists for. `unassigned` is where `ai_extracted` items land — a TRIAGE QUEUE — so
 * folding it into "show the groups that have items" reads the same on every fixture except the
 * one that matters: a case whose only items came out of the transcript pipeline.
 *
 * ⚠ THE EMPTY STATE IS AN INVITATION, NOT AN ABSENCE (balo-ui). "No action items yet" defines
 * the section by what it lacks; the copy here says what action items ARE and where they come
 * from, so the section reads as ready rather than broken.
 */

function item(
  over: Readonly<Partial<ActionItemNodeView>> & Readonly<{ id: string }>
): ActionItemNodeView {
  return {
    body: 'Send the sandbox credentials',
    status: 'open',
    assigneeParty: null,
    assigneeLabel: null,
    dueLabel: null,
    dueAtValue: null,
    isOverdue: false,
    ...over,
  };
}

function view(over: Readonly<Partial<CaseActionItemsView>> = {}): CaseActionItemsView {
  return {
    yours: [],
    theirs: [],
    unassigned: [],
    counterpartyLabel: 'Amara',
    doneCount: 0,
    totalCount: 0,
    ...over,
  };
}

/** The heading each bucket renders. `theirs` is `${counterpartyLabel}'s`. */
const YOURS = 'Yours';
const THEIRS = "Amara's";
const UNASSIGNED = 'Unassigned';
const INVITATION =
  'Anything you agree to do on a call lands here, so nothing gets lost between consultations.';

describe('CaseActionItems — the empty card invites rather than reporting an absence', () => {
  it('renders the invitation copy and NO bucket headings when nothing exists', () => {
    render(<CaseActionItems actionItems={view()} />);
    expect(screen.getByText(INVITATION)).toBeInTheDocument();
    for (const heading of [YOURS, THEIRS, UNASSIGNED]) {
      expect(screen.queryByText(heading)).not.toBeInTheDocument();
    }
  });

  it('never frames the empty state as an absence — no "No action items", no "yet"', () => {
    const { container } = render(<CaseActionItems actionItems={view()} />);
    const text = (container.textContent ?? '').toLowerCase();
    expect(text).not.toContain('no action items');
    expect(text).not.toContain('yet');
  });

  /** ⚠ 0-TOTAL EDGE: `0/0` is a progress claim about nothing. The meta is omitted entirely. */
  it('renders NO progress meta on the 0-total edge', () => {
    const { container } = render(<CaseActionItems actionItems={view()} />);
    expect(container.textContent ?? '').not.toContain('0/0');
    // The meta is the ONLY place a slash appears on this card, so its absence is the assertion
    // (stated without a regex — `regexp/no-super-linear-move` rejects `\d+\/\d+`).
    expect(container.textContent ?? '').not.toContain('/');
  });

  it('KEEPS the section rather than hiding it — the heading always renders', () => {
    render(<CaseActionItems actionItems={view()} />);
    expect(screen.getByRole('heading', { name: 'Action items' })).toBeInTheDocument();
  });
});

describe('CaseActionItems — the three buckets, each empty and non-empty', () => {
  it('renders YOURS alone when only the viewer has items', () => {
    render(
      <CaseActionItems
        actionItems={view({
          yours: [item({ id: 'a-1', body: 'Draft the migration plan' })],
          totalCount: 1,
        })}
      />
    );
    expect(screen.getByText(YOURS)).toBeInTheDocument();
    expect(screen.getByText(/Draft the migration plan/)).toBeInTheDocument();
    expect(screen.queryByText(THEIRS)).not.toBeInTheDocument();
    expect(screen.queryByText(UNASSIGNED)).not.toBeInTheDocument();
  });

  it("renders THEIRS under the counterparty's own label, not a generic word", () => {
    render(
      <CaseActionItems
        actionItems={view({
          theirs: [item({ id: 'a-2', body: 'Share the flow export' })],
          totalCount: 1,
        })}
      />
    );
    expect(screen.getByText(THEIRS)).toBeInTheDocument();
    expect(screen.getByText(/Share the flow export/)).toBeInTheDocument();
    expect(screen.queryByText('Theirs')).not.toBeInTheDocument();
    expect(screen.queryByText(YOURS)).not.toBeInTheDocument();
  });

  it('follows the counterpartyLabel it is given — the label is not hardcoded', () => {
    render(
      <CaseActionItems
        actionItems={view({
          counterpartyLabel: 'Northwind Industrial',
          theirs: [item({ id: 'a-3' })],
          totalCount: 1,
        })}
      />
    );
    expect(screen.getByText("Northwind Industrial's")).toBeInTheDocument();
    expect(screen.queryByText(THEIRS)).not.toBeInTheDocument();
  });

  /**
   * ⚠⚠ THE TRIAGE QUEUE. `ai_extracted` items land unassigned, so this is the ONLY place the
   * transcript pipeline's output becomes visible — hiding it when the other two are empty would
   * hide it exactly when it is the whole content of the card.
   */
  it('renders UNASSIGNED even when both other buckets are empty', () => {
    render(
      <CaseActionItems
        actionItems={view({
          unassigned: [item({ id: 'a-4', body: 'Confirm the sandbox refresh window' })],
          totalCount: 1,
        })}
      />
    );
    expect(screen.getByText(UNASSIGNED)).toBeInTheDocument();
    expect(screen.getByText(/Confirm the sandbox refresh window/)).toBeInTheDocument();
    expect(screen.queryByText(INVITATION)).not.toBeInTheDocument();
  });

  it('renders all three buckets together, each with its own items', () => {
    render(
      <CaseActionItems
        actionItems={view({
          yours: [item({ id: 'y-1', body: 'Mine' })],
          theirs: [item({ id: 't-1', body: 'Theirs' })],
          unassigned: [item({ id: 'u-1', body: 'Nobodys' })],
          totalCount: 3,
        })}
      />
    );
    for (const heading of [YOURS, THEIRS, UNASSIGNED]) {
      expect(screen.getByText(heading)).toBeInTheDocument();
    }
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });
});

describe('CaseActionItems — the progress meta states done over total', () => {
  it('renders doneCount/totalCount once there is anything to count', () => {
    render(
      <CaseActionItems
        actionItems={view({
          yours: [item({ id: 'y-1', status: 'done' }), item({ id: 'y-2' })],
          unassigned: [item({ id: 'u-1' })],
          doneCount: 1,
          totalCount: 3,
        })}
      />
    );
    expect(screen.getByText('1/3')).toBeInTheDocument();
  });

  it('renders a fully-done case as total/total, not as an empty card', () => {
    render(
      <CaseActionItems
        actionItems={view({
          yours: [item({ id: 'y-1', status: 'done' }), item({ id: 'y-2', status: 'done' })],
          doneCount: 2,
          totalCount: 2,
        })}
      />
    );
    expect(screen.getByText('2/2')).toBeInTheDocument();
    expect(screen.queryByText(INVITATION)).not.toBeInTheDocument();
  });

  it('marks each item done or open for a screen reader, not by strike-through alone', () => {
    render(
      <CaseActionItems
        actionItems={view({
          yours: [
            item({ id: 'y-1', body: 'Finished thing', status: 'done' }),
            item({ id: 'y-2', body: 'Outstanding thing' }),
          ],
          doneCount: 1,
          totalCount: 2,
        })}
      />
    );
    expect(screen.getByText('(done)')).toBeInTheDocument();
    expect(screen.getByText('(open)')).toBeInTheDocument();
  });

  /** ⚠ READ-ONLY ON THIS SURFACE — every case-grain toggle would 404 server-side (BAL-421). */
  it('offers no controls at all — the card is read-only here', () => {
    render(<CaseActionItems actionItems={view({ yours: [item({ id: 'y-1' })], totalCount: 1 })} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});
