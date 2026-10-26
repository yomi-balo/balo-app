import { htmlToPlainText } from '@/components/balo/rich-text/plain-text';

export type ProposalContentField = 'title' | 'description' | 'acceptance_criteria';

/** One wording field that differs from what the client agreed to, in plain text. */
export interface ProposalContentChange {
  field: ProposalContentField;
  label: 'Title' | 'Description' | 'Done when';
  before: string;
  after: string;
}

/** The three wording fields of a milestone, as stored. */
export interface MilestoneContent {
  title: string;
  descriptionHtml: string | null;
  acceptanceCriteria: string | null;
}

/** The fields an edit may set; an absent key is untouched. */
export type MilestoneContentEdit = Partial<MilestoneContent>;

/**
 * One audit row bearing on a milestone's wording, oldest first: a direct edit with the values it
 * replaced, or an approved change order's edit naming the wording fields it wrote.
 */
export type ProposalEditRow =
  | { kind: 'direct'; before: MilestoneContentEdit }
  | { kind: 'change_order'; resetFields: readonly (keyof MilestoneContent)[] };

interface FieldSpec {
  field: ProposalContentField;
  label: ProposalContentChange['label'];
  key: keyof MilestoneContent;
  plain: (value: string | null) => string;
}

const asText = (value: string | null): string => (value ?? '').trim();
const asHtmlText = (value: string | null): string => htmlToPlainText(value ?? '').trim();

const FIELDS: readonly FieldSpec[] = [
  { field: 'title', label: 'Title', key: 'title', plain: asText },
  { field: 'description', label: 'Description', key: 'descriptionHtml', plain: asHtmlText },
  {
    field: 'acceptance_criteria',
    label: 'Done when',
    key: 'acceptanceCriteria',
    plain: asText,
  },
];

/** The wording fields an edit would change, compared in plain text. */
export function diffProposalContent(
  before: MilestoneContent,
  after: MilestoneContentEdit
): ProposalContentChange[] {
  const changes: ProposalContentChange[] = [];
  for (const spec of FIELDS) {
    if (!(spec.key in after) || after[spec.key] === undefined) continue;
    const beforeText = spec.plain(before[spec.key]);
    const afterText = spec.plain(after[spec.key] ?? null);
    if (beforeText !== afterText) {
      changes.push({ field: spec.field, label: spec.label, before: beforeText, after: afterText });
    }
  }
  return changes;
}

/**
 * Per field, the value the client last agreed to, if a direct edit has replaced it since. Walks
 * the rows oldest first: the first direct edit of a field after its last reset records its
 * baseline, and an approved change order resets only the fields it wrote.
 */
function agreedBaselines(
  rows: readonly ProposalEditRow[]
): Map<keyof MilestoneContent, string | null> {
  const baselines = new Map<keyof MilestoneContent, string | null>();
  for (const row of rows) {
    if (row.kind === 'change_order') {
      for (const key of row.resetFields) baselines.delete(key);
      continue;
    }
    for (const spec of FIELDS) {
      if (spec.key in row.before && !baselines.has(spec.key)) {
        baselines.set(spec.key, row.before[spec.key] ?? null);
      }
    }
  }
  return baselines;
}

/**
 * What changed in one milestone's wording since the client last agreed to it. Rows are the
 * milestone's edit history, oldest first. An approved change order resets the baseline of each
 * field it wrote (the client approved that wording); a field it did not write keeps its earlier
 * baseline. Each field's "before" is the value the first direct edit after its last reset
 * replaced; a field edited back to that value drops.
 */
export function deriveProposalChanges(
  current: MilestoneContent,
  rows: readonly ProposalEditRow[]
): ProposalContentChange[] {
  const baselines = agreedBaselines(rows);
  const changes: ProposalContentChange[] = [];
  for (const spec of FIELDS) {
    if (!baselines.has(spec.key)) continue;
    const beforeText = spec.plain(baselines.get(spec.key) ?? null);
    const afterText = spec.plain(current[spec.key]);
    if (beforeText !== afterText) {
      changes.push({ field: spec.field, label: spec.label, before: beforeText, after: afterText });
    }
  }
  return changes;
}

const SIDE_MAX_CHARS = 60;

function side(text: string): string {
  if (text === '') return 'none';
  const cut = text.length > SIDE_MAX_CHARS ? `${text.slice(0, SIDE_MAX_CHARS)}…` : text;
  return `“${cut}”`;
}

/** `Title: “A” → “B”; Done when: none → “C”`, capped at `maxChars`. Empty for no changes. */
export function summarizeProposalChanges(
  changes: readonly ProposalContentChange[],
  maxChars = 300
): string {
  const summary = changes
    .map((change) => `${change.label}: ${side(change.before)} → ${side(change.after)}`)
    .join('; ');
  return summary.length > maxChars ? `${summary.slice(0, maxChars - 1)}…` : summary;
}
