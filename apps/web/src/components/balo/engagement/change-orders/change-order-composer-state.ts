/** The two pricing methods a project can be delivered under. */
export type ComposerPricing = 'fixed' | 'tm';

export type ComposerMilestoneStatus = 'pending' | 'in_progress' | 'completed';

/** A live milestone as the composer page hands it over (expert-side figures only). */
export interface ComposerMilestone {
  id: string;
  title: string;
  descriptionText: string | null;
  status: ComposerMilestoneStatus;
  estimatedMinutes: number | null;
}

export type ComposerLineOp = 'add' | 'edit' | 'remove';

/** One line of a saved draft, as the composer page hands it over. */
export interface ComposerSavedLine {
  op: ComposerLineOp;
  milestoneId: string | null;
  title: string;
  descriptionText: string | null;
  estimatedMinutes: number | null;
}

/** One line as `saveChangeOrderAction` accepts it. */
export interface ComposerLineDraft {
  op: ComposerLineOp;
  milestoneId?: string;
  title: string;
  descriptionText?: string | null;
  estimatedMinutes?: number | null;
}

/** The milestone as it stood when the composer opened, kept to detect an edit. */
interface ComposerOriginal {
  title: string;
  description: string;
  estimatedMinutes: number | null;
}

/** One editable row: a live milestone (possibly edited / removed) or a new one. */
export interface ComposerRow {
  key: string;
  milestoneId: string | null;
  status: ComposerMilestoneStatus;
  title: string;
  description: string;
  /** Hours, as typed (the input is hours-facing; lines carry whole minutes). */
  hours: string;
  removed: boolean;
  isNew: boolean;
  orig: ComposerOriginal | null;
}

export type ComposerRowState = 'unchanged' | 'edited' | 'new' | 'removed';

/** Whole minutes → the hours string a row's input shows ("90" → "1.5"). */
export function minutesToHoursInput(minutes: number | null): string {
  if (minutes === null) return '';
  return String(Math.round((minutes / 60) * 100) / 100);
}

/** An hours string → whole minutes, or null when blank / invalid / not positive. */
export function hoursInputToMinutes(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number.parseFloat(trimmed);
  if (Number.isNaN(parsed) || parsed <= 0) return null;
  return Math.round(parsed * 60);
}

function blankOriginal(milestone: ComposerMilestone): ComposerOriginal {
  return {
    title: milestone.title,
    description: milestone.descriptionText ?? '',
    estimatedMinutes: milestone.estimatedMinutes,
  };
}

/** A fresh, empty "new milestone" row. */
export function blankRow(key: string): ComposerRow {
  return {
    key,
    milestoneId: null,
    status: 'pending',
    title: '',
    description: '',
    hours: '',
    removed: false,
    isNew: true,
    orig: null,
  };
}

/**
 * The composer's starting rows: every live milestone pre-filled, then the saved draft's
 * lines laid over them (an `edit` overwrites the fields, a `remove` marks the row, an `add`
 * appends a new row). A saved line whose milestone is no longer live is skipped.
 */
export function rowsFor(
  milestones: readonly ComposerMilestone[],
  lines: readonly ComposerSavedLine[],
  newKey: () => string
): ComposerRow[] {
  const rows: ComposerRow[] = milestones.map((milestone) => ({
    key: milestone.id,
    milestoneId: milestone.id,
    status: milestone.status,
    title: milestone.title,
    description: milestone.descriptionText ?? '',
    hours: minutesToHoursInput(milestone.estimatedMinutes),
    removed: false,
    isNew: false,
    orig: blankOriginal(milestone),
  }));
  for (const line of lines) {
    if (line.op === 'add') {
      rows.push({
        ...blankRow(newKey()),
        title: line.title,
        description: line.descriptionText ?? '',
        hours: minutesToHoursInput(line.estimatedMinutes),
      });
      continue;
    }
    const row = rows.find((candidate) => candidate.milestoneId === line.milestoneId);
    if (row === undefined) continue;
    if (line.op === 'remove') {
      row.removed = true;
    } else {
      row.title = line.title;
      row.description = line.descriptionText ?? '';
      if (line.estimatedMinutes !== null) row.hours = minutesToHoursInput(line.estimatedMinutes);
    }
  }
  return rows;
}

function rowChanged(row: ComposerRow, orig: ComposerOriginal, pricing: ComposerPricing): boolean {
  if (row.title.trim() !== orig.title) return true;
  if (row.description.trim() !== orig.description) return true;
  return pricing === 'tm' && hoursInputToMinutes(row.hours) !== orig.estimatedMinutes;
}

/** Where a row stands against the plan it started from. */
export function rowState(row: ComposerRow, pricing: ComposerPricing): ComposerRowState {
  if (row.isNew) return 'new';
  if (row.removed) return 'removed';
  if (row.orig === null) return 'unchanged';
  return rowChanged(row, row.orig, pricing) ? 'edited' : 'unchanged';
}

function descriptionOrNull(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function estimateFor(
  row: ComposerRow,
  pricing: ComposerPricing
): { estimatedMinutes?: number | null } {
  return pricing === 'tm' ? { estimatedMinutes: hoursInputToMinutes(row.hours) } : {};
}

/** The line one row emits, or null when the row contributes nothing. */
function lineFor(row: ComposerRow, pricing: ComposerPricing): ComposerLineDraft | null {
  if (row.isNew) {
    if (row.removed) return null;
    return {
      op: 'add',
      title: row.title.trim(),
      descriptionText: descriptionOrNull(row.description),
      ...estimateFor(row, pricing),
    };
  }
  const { orig, milestoneId } = row;
  if (orig === null || milestoneId === null) return null;
  if (row.removed) return { op: 'remove', milestoneId, title: orig.title };
  if (!rowChanged(row, orig, pricing)) return null;
  return {
    op: 'edit',
    milestoneId,
    title: row.title.trim(),
    descriptionText: descriptionOrNull(row.description),
    ...estimateFor(row, pricing),
  };
}

/** The lines the rows amount to: only added, edited and removed rows emit one. */
export function linesFrom(
  rows: readonly ComposerRow[],
  pricing: ComposerPricing
): ComposerLineDraft[] {
  const lines: ComposerLineDraft[] = [];
  for (const row of rows) {
    const line = lineFor(row, pricing);
    if (line !== null) lines.push(line);
  }
  return lines;
}

export interface ComposerCounts {
  added: number;
  edited: number;
  removed: number;
}

export function countLines(lines: readonly ComposerLineDraft[]): ComposerCounts {
  return {
    added: lines.filter((line) => line.op === 'add').length,
    edited: lines.filter((line) => line.op === 'edit').length,
    removed: lines.filter((line) => line.op === 'remove').length,
  };
}

/** The T&M estimate before and after the rows are applied, in whole minutes. */
export function estimateTotals(
  milestones: readonly ComposerMilestone[],
  rows: readonly ComposerRow[]
): { currentMinutes: number; nextMinutes: number } {
  const currentMinutes = milestones.reduce(
    (sum, milestone) => sum + (milestone.estimatedMinutes ?? 0),
    0
  );
  const nextMinutes = rows
    .filter((row) => !row.removed)
    .reduce((sum, row) => sum + (hoursInputToMinutes(row.hours) ?? 0), 0);
  return { currentMinutes, nextMinutes };
}

interface ComposerIssueInput {
  pricing: ComposerPricing;
  note: string;
  lines: readonly ComposerLineDraft[];
  /** Fixed price: the typed total minus the current total (0 on T&M). */
  priceDeltaCents: number;
  /** Fixed price: whether the typed total parses to a non-negative amount. */
  priceValid: boolean;
}

/** What stops one line from being sent. */
function lineIssues(line: ComposerLineDraft, pricing: ComposerPricing): string[] {
  const issues: string[] = [];
  if (line.op === 'add' && line.title === '') issues.push('Give each new milestone a name.');
  if (line.op === 'edit' && line.title === '') issues.push('Give each milestone a name.');
  const needsEstimate = pricing === 'tm' && (line.op === 'add' || line.op === 'edit');
  if (needsEstimate && (line.estimatedMinutes ?? 0) <= 0) {
    issues.push(`Add an estimate in hours for ${line.title || 'the new milestone'}.`);
  }
  return issues;
}

/** What stops a send, in the order the form reads. Mirrors the server's coherence rules. */
export function composerIssues(input: ComposerIssueInput): string[] {
  const { pricing, note, lines, priceDeltaCents, priceValid } = input;
  const issues: string[] = [];
  if (note.trim() === '') issues.push("Add a short summary of what's changing and why.");
  if (lines.length === 0 && priceDeltaCents === 0) {
    issues.push('Change at least one milestone or the price.');
  }
  for (const line of lines) issues.push(...lineIssues(line, pricing));
  if (pricing === 'fixed' && !priceValid) issues.push('Enter a project price of zero or more.');
  return [...new Set(issues)];
}
