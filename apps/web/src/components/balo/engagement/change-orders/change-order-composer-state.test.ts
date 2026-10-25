import { describe, expect, it } from 'vitest';

import {
  blankRow,
  composerIssues,
  countLines,
  estimateTotals,
  hoursInputToMinutes,
  linesFrom,
  minutesToHoursInput,
  rowState,
  rowsFor,
  type ComposerMilestone,
  type ComposerRow,
  type ComposerSavedLine,
} from './change-order-composer-state';

const MILESTONES: ComposerMilestone[] = [
  {
    id: 'm1',
    title: 'Discovery',
    descriptionText: 'Workshops.',
    status: 'completed',
    estimatedMinutes: 600,
  },
  {
    id: 'm2',
    title: 'Build',
    descriptionText: null,
    status: 'in_progress',
    estimatedMinutes: 1200,
  },
];

let counter = 0;
const newKey = (): string => {
  counter += 1;
  return `new-${counter}`;
};

function rows(lines: ComposerSavedLine[] = []): ComposerRow[] {
  return rowsFor(MILESTONES, lines, newKey);
}

function rowAt(list: ComposerRow[], index: number): ComposerRow {
  const row = list[index];
  if (row === undefined) throw new Error(`no row at ${index}`);
  return row;
}

describe('input parsing and formatting', () => {
  it('converts minutes to an hours string and back', () => {
    expect(minutesToHoursInput(90)).toBe('1.5');
    expect(minutesToHoursInput(null)).toBe('');
    expect(hoursInputToMinutes('1.5')).toBe(90);
    expect(hoursInputToMinutes(' 2 ')).toBe(120);
  });

  it('rejects blank, non-numeric and non-positive hours', () => {
    expect(hoursInputToMinutes('')).toBeNull();
    expect(hoursInputToMinutes('abc')).toBeNull();
    expect(hoursInputToMinutes('0')).toBeNull();
    expect(hoursInputToMinutes('-1')).toBeNull();
  });
});

describe('rowsFor', () => {
  it('pre-fills a row per live milestone with hours and the original snapshot', () => {
    const list = rows();
    expect(list).toHaveLength(2);
    expect(rowAt(list, 0)).toMatchObject({
      key: 'm1',
      milestoneId: 'm1',
      title: 'Discovery',
      description: 'Workshops.',
      hours: '10',
      removed: false,
      isNew: false,
      orig: { title: 'Discovery', description: 'Workshops.', estimatedMinutes: 600 },
    });
    expect(rowAt(list, 1).description).toBe('');
  });

  it('lays a saved draft over the live plan', () => {
    const list = rows([
      {
        op: 'edit',
        milestoneId: 'm2',
        title: 'Build v2',
        descriptionText: 'More.',
        estimatedMinutes: 1800,
      },
      {
        op: 'remove',
        milestoneId: 'm1',
        title: 'Discovery',
        descriptionText: null,
        estimatedMinutes: null,
      },
      {
        op: 'add',
        milestoneId: null,
        title: 'Dashboard',
        descriptionText: 'KPI.',
        estimatedMinutes: 300,
      },
    ]);
    expect(list).toHaveLength(3);
    expect(rowAt(list, 0).removed).toBe(true);
    expect(rowAt(list, 1)).toMatchObject({ title: 'Build v2', description: 'More.', hours: '30' });
    expect(rowAt(list, 2)).toMatchObject({ isNew: true, title: 'Dashboard', hours: '5' });
  });

  it('skips a saved line whose milestone is no longer live', () => {
    const list = rows([
      {
        op: 'edit',
        milestoneId: 'gone',
        title: 'X',
        descriptionText: null,
        estimatedMinutes: null,
      },
    ]);
    expect(list).toHaveLength(2);
    expect(rowAt(list, 0).title).toBe('Discovery');
  });
});

describe('rowState', () => {
  it('is unchanged until a field differs, then edited', () => {
    const list = rows();
    expect(rowState(rowAt(list, 0), 'fixed')).toBe('unchanged');
    expect(rowState({ ...rowAt(list, 0), title: 'Discovery+' }, 'fixed')).toBe('edited');
    expect(rowState({ ...rowAt(list, 0), description: 'Other' }, 'fixed')).toBe('edited');
  });

  it('treats an estimate change as an edit on T&M only', () => {
    const changed = { ...rowAt(rows(), 0), hours: '12' };
    expect(rowState(changed, 'tm')).toBe('edited');
    expect(rowState(changed, 'fixed')).toBe('unchanged');
  });

  it('reports new and removed rows', () => {
    expect(rowState(blankRow('k'), 'fixed')).toBe('new');
    expect(rowState({ ...rowAt(rows(), 0), removed: true }, 'fixed')).toBe('removed');
  });
});

describe('linesFrom', () => {
  it('emits nothing for an untouched plan', () => {
    expect(linesFrom(rows(), 'fixed')).toEqual([]);
  });

  it('emits add, edit and remove lines only for changed rows', () => {
    const list = rows();
    const edited = { ...rowAt(list, 1), title: ' Build v2 ', description: ' More ' };
    const removed = { ...rowAt(list, 0), removed: true };
    const added = { ...blankRow('n'), title: ' Dashboard ', description: '' };
    expect(linesFrom([removed, edited, added], 'fixed')).toEqual([
      { op: 'remove', milestoneId: 'm1', title: 'Discovery' },
      { op: 'edit', milestoneId: 'm2', title: 'Build v2', descriptionText: 'More' },
      { op: 'add', title: 'Dashboard', descriptionText: null },
    ]);
  });

  it('carries estimates in minutes on T&M, and an estimate change alone is an edit', () => {
    const list = rows();
    const estimateOnly = { ...rowAt(list, 1), hours: '30' };
    const added = { ...blankRow('n'), title: 'Dashboard', hours: '2.5' };
    expect(linesFrom([estimateOnly, added], 'tm')).toEqual([
      {
        op: 'edit',
        milestoneId: 'm2',
        title: 'Build',
        descriptionText: null,
        estimatedMinutes: 1800,
      },
      { op: 'add', title: 'Dashboard', descriptionText: null, estimatedMinutes: 150 },
    ]);
  });

  it('drops a new row that was removed', () => {
    expect(linesFrom([{ ...blankRow('n'), title: 'X', removed: true }], 'fixed')).toEqual([]);
  });
});

describe('countLines and estimateTotals', () => {
  it('counts lines by op', () => {
    expect(
      countLines([
        { op: 'add', title: 'a' },
        { op: 'add', title: 'b' },
        { op: 'edit', milestoneId: 'm1', title: 'c' },
        { op: 'remove', milestoneId: 'm2', title: 'd' },
      ])
    ).toEqual({ added: 2, edited: 1, removed: 1 });
  });

  it('totals the estimate before and after, ignoring removed rows', () => {
    const list = rows();
    const next = [
      { ...rowAt(list, 0), removed: true },
      { ...rowAt(list, 1), hours: '30' },
      { ...blankRow('n'), hours: '5' },
    ];
    expect(estimateTotals(MILESTONES, next)).toEqual({ currentMinutes: 1800, nextMinutes: 2100 });
  });
});

describe('composerIssues', () => {
  const base = {
    pricing: 'fixed' as const,
    note: 'Why',
    lines: [{ op: 'add' as const, title: 'New' }],
    priceDeltaCents: 0,
    priceValid: true,
  };

  it('is empty for a coherent change', () => {
    expect(composerIssues(base)).toEqual([]);
  });

  it('asks for a summary', () => {
    expect(composerIssues({ ...base, note: '  ' })).toEqual([
      "Add a short summary of what's changing and why.",
    ]);
  });

  it('asks for a real change when there are no lines and no price movement', () => {
    expect(composerIssues({ ...base, lines: [] })).toEqual([
      'Change at least one milestone or the price.',
    ]);
    expect(composerIssues({ ...base, lines: [], priceDeltaCents: 5000 })).toEqual([]);
  });

  it('names unnamed milestones once', () => {
    const issues = composerIssues({
      ...base,
      lines: [
        { op: 'add', title: '' },
        { op: 'add', title: '' },
        { op: 'edit', milestoneId: 'm1', title: '' },
      ],
    });
    expect(issues).toEqual(['Give each new milestone a name.', 'Give each milestone a name.']);
  });

  it('requires an estimate on added and edited T&M lines', () => {
    const issues = composerIssues({
      ...base,
      pricing: 'tm',
      lines: [
        { op: 'add', title: 'Dashboard', estimatedMinutes: null },
        { op: 'edit', milestoneId: 'm1', title: 'Build', estimatedMinutes: 0 },
        { op: 'remove', milestoneId: 'm2', title: 'Old' },
      ],
    });
    expect(issues).toEqual([
      'Add an estimate in hours for Dashboard.',
      'Add an estimate in hours for Build.',
    ]);
  });

  it('flags an invalid price on fixed and an invalid cap on T&M', () => {
    expect(composerIssues({ ...base, priceValid: false })).toEqual([
      'Enter a project price of zero or more.',
    ]);
    expect(
      composerIssues({
        ...base,
        pricing: 'tm',
        lines: [{ op: 'remove', milestoneId: 'm1', title: 'x' }],
        priceValid: false,
      })
    ).toEqual(['Enter a cap of zero or more.']);
  });

  it('counts a cap change as a change on T&M', () => {
    expect(composerIssues({ ...base, pricing: 'tm', lines: [], priceDeltaCents: 50_000 })).toEqual(
      []
    );
  });
});
