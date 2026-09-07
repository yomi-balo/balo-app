import { describe, it, expect } from 'vitest';
import { buildJobId } from '../lib/queue.js';
import { recordingCleanupSourceJobId } from '../jobs/recording-cleanup-source.js';
import { ALL_SOURCE_FILES, isCommentLine, isUnderAny, readRaw } from './_source-scan.js';

/**
 * BAL-531 — **A CUSTOM BullMQ `jobId` MAY ONLY BE MINTED BY `buildJobId`.**
 *
 * The rule this file guards:
 *
 * > A code LINE containing a construction marker for `jobId` (an ASSIGNMENT or an object-key
 * > SET — the only forms that can mint an id) must also contain a blessed builder call on that
 * > same line, unless the line matches a pinned non-queue shape (a structured LOG field, not a
 * > BullMQ option).
 *
 * ⚠⚠ WHY THIS IS A LINE-LEVEL SCAN, NOT A FILE-LEVEL ONE (unlike its two siblings in this
 * directory). The BullMQ bug this ticket fixes is exactly a hand-rolled template literal SITTING
 * ON THE SAME LINE as `jobId:` / `jobId =` — a file-level "does this file mention buildJobId
 * anywhere" check would pass a file that calls `buildJobId` once for an unrelated queue and
 * still hand-rolls a second, broken jobId five lines later. Keying the check to the CONSTRUCTION
 * line is what closes that hole.
 *
 * ⚠⚠ THIS IS THE THIRD CONSUMER OF `./_source-scan.ts` — extracted, not invented, exactly as
 * that helper's own docblock asks. Its shape (non-vacuity block, positive controls, a directory
 * walk with no pinned file list) mirrors `no-counterparty-address-on-calendar-writes.test.ts`;
 * read that file first if this one is confusing.
 *
 * ⚠ NO REGEX ANYWHERE (SonarCloud S5852 / `regexp/no-super-linear-move`). `includes` / `indexOf`
 * / `split` only — see `_source-scan.ts`'s docblock for the comment-classifier and
 * `import.meta.url` reasoning this file relies on but does not re-derive.
 *
 * IF THIS TEST FAILS ON A LINE THAT GENUINELY MINTS A jobId, THE REMEDY IS TO ROUTE IT THROUGH
 * `buildJobId` — see `apps/api/src/lib/queue.ts`'s docblock. Do NOT widen `BLESSED_JOB_ID_BUILDERS`
 * or `NON_QUEUE_JOB_ID_SHAPES` just to make that failure go away.
 *
 * ⚠⚠ FIX ROUND 2 (G3) — THAT GUIDANCE IS ABOUT A REAL CONSTRUCTION, NOT ABOUT EVERY MATCH. A
 * `jobId: string` / `jobId?: string` TYPE ANNOTATION on a function parameter also contains the
 * `jobId:` marker and used to be flagged here — it mints nothing, it names a parameter's type.
 * `services/daily/batch-processor.ts`'s `getBatchJobTranscriptLink` paid a rename tax for exactly
 * this (`jobId` → `batchJobId`) before this shape was recognised. The rename is KEPT — `batchJobId`
 * is a genuinely better name for a Daily batch job id than the generic `jobId` — but it is no
 * longer *required*: a future parameter named `jobId: string` passes this scan today via
 * `NON_QUEUE_JOB_ID_SHAPES` below, same as the pinned log-field shapes.
 */

const REMEDY =
  'BAL-531: a custom BullMQ jobId may only be minted by buildJobId(). If this line actually ' +
  'CONSTRUCTS a jobId (an assignment or object-key set feeding `queue.add`/a BullMQ option), ' +
  'route it through buildJobId() instead of a hand-rolled template. If it is not a construction ' +
  'at all — e.g. a `jobId: string` type annotation or a structured log field — add its exact ' +
  'shape to NON_QUEUE_JOB_ID_SHAPES instead of hand-editing the offending line.';

/**
 * `jobId` being ASSIGNED or set as an object key — the only forms that can mint an id.
 *
 * ⚠ FIX ROUND (F6) — `['jobId']` was added to catch the cheap COMPUTED-key shape
 * (`{ ['jobId']: x }`), which the first three markers miss: that text contains neither
 * `jobId:` nor `jobId =` (it reads `jobId']:`, not `jobId:`). Two adversarial shapes remain
 * uncaught ON PURPOSE — a destructure-rename plus shorthand (`const { id: jobId } = …` then
 * `{ jobId }`) and a dynamically-built key (`{ ['job' + 'Id']: x }`) — see `lib/queue.ts`'s
 * docblock, which now names these residual shapes instead of overselling this scan as airtight
 * against a deliberately adversarial author.
 */
const CONSTRUCTION_MARKERS = ['jobId:', 'jobId =', 'jobId=', "['jobId']"] as const;

/**
 * The ONLY functions allowed to produce a job id. A third entry is a DECISION, not a
 * convenience: the helper must delegate to `buildJobId`, and the behavioural test below proves
 * the second one does rather than trusting this list.
 */
const BLESSED_JOB_ID_BUILDERS = ['buildJobId(', 'recordingCleanupSourceJobId('] as const;

/**
 * `jobId:` that is NOT a BullMQ option:
 *  · a structured LOG field in a `worker.on('failed')` handler (the router worker plus three
 *    channel adapters) — `jobId: job?.id` / `jobId: job.id`;
 *  · FIX ROUND 2 (G3) — a `jobId: string` / `jobId?: string` TYPE ANNOTATION on a function
 *    parameter, which mints nothing at all. See this file's module docblock for why this was
 *    added and what it makes no-longer-required (the `batchJobId` rename).
 * Shape-based, not file-based, so a fifth channel adapter — or a fifth `jobId: string` parameter
 * — passes without an edit to this list.
 */
const NON_QUEUE_JOB_ID_SHAPES = [
  'jobId: job?.id',
  'jobId: job.id',
  'jobId: string',
  'jobId?: string',
] as const;

/**
 * Guards must be able to NAME what they forbid.
 *
 * ⚠ FIX ROUND (F10) — HONEST STATUS: this exemption guards NOTHING today. `collectSourceFiles`
 * already excludes every `*.test.ts` file, so this suite's own file is never a scan subject
 * regardless of this list; the only OTHER file under `invariants/` is `_source-scan.ts`, which
 * contains zero occurrences of `jobId`. The "excluding invariants/ removed something" assertion
 * below passes because it removes exactly that one inert file — coincidence, not evidence this
 * exemption does load-bearing work. Kept anyway as a FORWARD guard: a future non-test helper
 * added to `invariants/` (mirroring `_source-scan.ts`) that happens to reference `jobId` in a
 * comment or fixture would otherwise become a scan subject and could false-positive. If this
 * list is ever dropped, drop the "removed something" assertion with it — it would fail
 * (correctly) the moment nothing under `invariants/` needs excluding.
 */
const SCAN_EXEMPT = ['invariants/'] as const;

/** One line of `apps/api/src` source, with its home file and 1-based line number. */
interface SourceLine {
  file: string;
  lineNumber: number;
  text: string;
}

/** Every non-comment line across `files`, each tagged with its origin for a readable failure. */
function nonCommentLines(files: readonly string[]): SourceLine[] {
  const lines: SourceLine[] = [];
  for (const file of files) {
    const raw = readRaw(file);
    const rawLines = raw.split('\n');
    for (const [index, text] of rawLines.entries()) {
      if (isCommentLine(text)) continue;
      lines.push({ file, lineNumber: index + 1, text });
    }
  }
  return lines;
}

/** A construction line is one that mints a jobId — the shape this whole invariant keys on. */
function isConstructionLine(text: string): boolean {
  return CONSTRUCTION_MARKERS.some((marker) => text.includes(marker));
}

function hasBlessedBuilder(text: string): boolean {
  return BLESSED_JOB_ID_BUILDERS.some((builder) => text.includes(builder));
}

function isPinnedNonQueueShape(text: string): boolean {
  return NON_QUEUE_JOB_ID_SHAPES.some((shape) => text.includes(shape));
}

/**
 * The core predicate: true when a line mints a jobId WITHOUT going through a blessed builder and
 * WITHOUT matching a pinned non-queue shape. Shared by the main scan and the positive controls
 * below, so both exercise the identical logic.
 */
function isOffendingLine(text: string): boolean {
  if (isCommentLine(text)) return false;
  if (!isConstructionLine(text)) return false;
  if (hasBlessedBuilder(text)) return false;
  if (isPinnedNonQueueShape(text)) return false;
  return true;
}

// ── Non-vacuity — the walk ran, found the right files, and excluding invariants/ did something ──

describe('non-vacuity — the scan actually walked apps/api/src', () => {
  const scanned = ALL_SOURCE_FILES.filter((rel) => !isUnderAny(rel, SCAN_EXEMPT));

  it('the full source surface is large, and named files are present', () => {
    expect(ALL_SOURCE_FILES.length).toBeGreaterThan(200);
    expect(ALL_SOURCE_FILES).toContain('lib/queue.ts');
    expect(ALL_SOURCE_FILES).toContain('notifications/engine/dispatcher.ts');
    expect(ALL_SOURCE_FILES).toContain('jobs/meeting-calendar-amend.ts');
    expect(ALL_SOURCE_FILES).toContain('jobs/transcript-pipeline.ts');
  });

  it('excluding invariants/ removed something, and removed only what it claims to', () => {
    expect(ALL_SOURCE_FILES.length - scanned.length).toBeGreaterThan(0);
    expect(scanned.some((rel) => rel.startsWith('invariants/'))).toBe(false);
  });

  it('every scanned file reads as non-empty (a silent read failure is a vacuous pass)', () => {
    for (const rel of scanned) {
      expect(readRaw(rel).length, `${rel} read as empty`).toBeGreaterThan(0);
    }
  });
});

// ── The scan itself ───────────────────────────────────────────────────────────────────────────

describe('the scan — no jobId construction line bypasses buildJobId', () => {
  const scanned = ALL_SOURCE_FILES.filter((rel) => !isUnderAny(rel, SCAN_EXEMPT));
  const lines = nonCommentLines(scanned);

  it('no offenders (revert any enqueue site to a hand-rolled template to see this name it)', () => {
    const offenders = lines
      .filter((line) => isOffendingLine(line.text))
      .map((line) => `${line.file}:${line.lineNumber}: ${line.text.trim()}`);

    expect(offenders, `${offenders.join('\n')}\n${REMEDY}`).toEqual([]);
  });
});

// ── Each blessed builder is LIVE — a name that matches nothing is dead and must be deleted ─────

describe('each blessed builder is live in the tree', () => {
  const scanned = ALL_SOURCE_FILES.filter((rel) => !isUnderAny(rel, SCAN_EXEMPT));
  const constructionLines = nonCommentLines(scanned).filter((line) =>
    isConstructionLine(line.text)
  );

  it('at least one jobId: line names buildJobId(', () => {
    const count = constructionLines.filter((line) => line.text.includes('buildJobId(')).length;
    expect(count).toBeGreaterThan(0);
  });

  it('at least one jobId: line names recordingCleanupSourceJobId(', () => {
    const count = constructionLines.filter((line) =>
      line.text.includes('recordingCleanupSourceJobId(')
    ).length;
    expect(count).toBeGreaterThan(0);
  });
});

// ── Each non-queue shape is LIVE — an exemption that matches nothing silently widens ───────────

describe('the pinned non-queue shape is live (a rename that kills it must fail loudly)', () => {
  const scanned = ALL_SOURCE_FILES.filter((rel) => !isUnderAny(rel, SCAN_EXEMPT));
  const lines = nonCommentLines(scanned);

  it('`jobId: job?.id` still appears at least 4 times (the router worker + three channel adapters)', () => {
    const count = lines.filter((line) => line.text.includes('jobId: job?.id')).length;
    expect(count).toBeGreaterThanOrEqual(4);
  });
});

// ── Delegation proved by BEHAVIOUR, not grep — the blessed list is not a hole ───────────────────

describe('recordingCleanupSourceJobId genuinely delegates to buildJobId', () => {
  it('the bare (no-dedupeToken) form', () => {
    expect(recordingCleanupSourceJobId('r-1')).toBe(buildJobId('recording-cleanup-source', 'r-1'));
  });

  it('the two-arg (dedupeToken) form', () => {
    expect(recordingCleanupSourceJobId('r-1', 'daily-batch-9')).toBe(
      buildJobId('recording-cleanup-source', 'r-1', 'daily-batch-9')
    );
  });
});

// ── The BullMQ rule itself, pinned once — see also lib/queue.test.ts's dedicated suite ─────────

describe('the actual BullMQ rule, restated here so this invariant does not silently drift from it', () => {
  it('buildJobId output never contains a colon, and always satisfies the upstream predicate', () => {
    const fixtures = [
      buildJobId('meeting-calendar-amend', 'audit-1'),
      buildJobId('credit-session-low-balance', 'user-1', 'calendar-sub-lapse:2026-09-04'),
      buildJobId('recording-cleanup-source', 'r-1', 'daily-batch-9'),
    ];
    for (const id of fixtures) {
      expect(id.includes(':')).toBe(false);
      expect(id.includes(':') && id.split(':').length !== 3).toBe(false);
    }
  });
});

// ── Positive controls — a scan that has never been seen to match proves nothing ─────────────────

describe('the matchers actually fire (positive controls)', () => {
  it('fires on an object-key jobId construction', () => {
    expect(isOffendingLine('const x = { jobId: `a-${b}` };')).toBe(true);
  });

  it('fires on a `+`-concatenation assignment, identically to a template literal', () => {
    expect(isOffendingLine("let jobId = 'a' + b;")).toBe(true);
  });

  it('fires on a computed-key jobId construction (F6 — the original three markers miss this)', () => {
    expect(isOffendingLine("const x = { ['jobId']: `a-${b}` };")).toBe(true);
  });

  it('a blessed builder call on the SAME line does not fire', () => {
    expect(isOffendingLine('const x = { jobId: buildJobId(a, b) };')).toBe(false);
    expect(isOffendingLine('jobId: recordingCleanupSourceJobId(id, token),')).toBe(false);
  });

  it('a pinned non-queue shape does not fire', () => {
    expect(isOffendingLine('log.error({ jobId: job?.id, error: err.message }, "x");')).toBe(false);
  });

  it('a `jobId: string` / `jobId?: string` TYPE ANNOTATION does not fire (fix round 2, G3)', () => {
    // The exact shape `services/daily/batch-processor.ts` used to be forced to rename away from
    // — it mints nothing, it names a parameter's type. Kept as a forward guard, like
    // `SCAN_EXEMPT`'s own F10 note: this shape has no live occurrence in `apps/api/src` today
    // (the rename already happened), so this is proved only here, not by the source walk.
    expect(
      isOffendingLine('export function f(jobId: string, format: "json"): Promise<string> {')
    ).toBe(false);
    expect(isOffendingLine('function g(jobId?: string): void {}')).toBe(false);
  });

  it('⚠ does NOT fire on a COMMENT — the classifier is live', () => {
    expect(isOffendingLine('// jobId is built by buildJobId')).toBe(false);
    expect(isOffendingLine(' * jobId: buildJobId(event, correlationId)')).toBe(false);
  });

  it('⚠ a trailing comment after real code still fires (false ALARM, never false PASS)', () => {
    // The classifier drops whole comment LINES only — a marker after a trailing `//` survives
    // on the same line as real code, which is the safe direction for a fail-closed invariant.
    expect(isOffendingLine('const x = 1; // jobId:')).toBe(true);
  });

  it('a bare reference (no marker) never fires — only the assignment line is caught', () => {
    expect(
      isOffendingLine('channelQueue.add(rule.template, payload, { jobId, attempts: 3 });')
    ).toBe(false);
    expect(isOffendingLine('log.info({ jobId }, "enqueued");')).toBe(false);
  });
});
