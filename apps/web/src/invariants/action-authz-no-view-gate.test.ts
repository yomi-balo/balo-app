import { describe, expect, it } from 'vitest';
import {
  codeLinesOf,
  hasUseServerDirective,
  resolveRouteDir,
  scanRouteSources,
  type ScannedFile,
} from './_source-scan';

/**
 * BAL-438 — structural invariant: **NO WEB SERVER ACTION COMPARES A ROLE, LENS OR ACTIVE MODE
 * (`===` / `!==` / `switch`) OUTSIDE AN AUDITED EXCLUSION.**
 *
 * ADR-1029: authorization is resolved as a capability at the call site (`hasCapability`,
 * `hasEngagementCapability`, `hasPlatformCapability`, or `resolveApprovedExpert` for the
 * approved-expert write gate). `activeMode` is a view toggle, `lens` is derived view shaping, and a
 * role string is interpreted into capabilities in exactly one place (`@balo/shared/authz`). A
 * `===` / `!==` / `switch` on any of them inside a Server Action is a view gate standing in for a
 * permission check.
 *
 * SCAN SET. Every non-test `.ts`/`.tsx` under `apps/web/src` that is a Server Action module (the
 * `'use server'` directive as first statement) PLUS everything under `lib/actions/`, which holds
 * server-only write paths (`expert-checklist.ts`) that are not directive-marked. Covering every
 * `server-only` module was measured and rejected: ~380 files and ~60 view-branching hits in
 * read-side shaping code (`load-case.ts`, `engagement-view.ts`, ...), which would not converge.
 * This is the repo-wide rule `meeting-call-no-lens-gate.test.ts` deferred.
 *
 * NOT SCANNED, ON PURPOSE.
 *  - `apps/api`: a survey found no violations, only view shaping after authorization.
 *  - `side` and `viewer` are not tokens: they are resolver OUTPUT (request-file `scope.side`,
 *    fast-forward `side`) and guest/member subject kind, not a role/lens/mode read.
 *
 * MATCHER. Pure string scanning over comment-stripped, whitespace-normalised code (so a
 * Prettier-wrapped comparison cannot slip past): every `===`/`!==` is located by `indexOf`, both
 * operands are read as an identifier chain or a quoted literal, and the comparison is a hit when
 * the LAST chain segment of either operand is one of `VIEW_TOKENS` and the other operand is not
 * `undefined`/`null` (a null-guard is not a gate). `switch (<chain>)` on a token is a hit too.
 * The only regex is the whitespace collapse.
 *
 * KNOWN LIMITS. This is a textual comparison scan. It does NOT catch: aliasing a token to a local
 * (`const m = user.activeMode; if (m !== 'expert')`), loose `!=`/`==`, `.includes(role)`, bracket
 * access, tokens outside `VIEW_TOKENS` (e.g. `memberRole`), or a comparison wrapped in a helper
 * that lives outside the scan set. `submit-billing-details.ts` additionally passes
 * `user.companyRole` into `canManageBilling(...)`; that is not a comparison, so it is tracked with
 * its lens gate in BAL-596.
 *
 * A `redundant-routing-assertion` entry is checked for exactly this much: the file's code has a
 * `hasCapability(` or `hasEngagementCapability(` call positioned AFTER every occurrence of the
 * excluded comparison. It proves ordering, not that the call guards the same branch.
 *
 * EXCLUSIONS are never an `activeMode`/`companyRole` entry: those were FIXED. Only the eleven
 * `deferred-bal-596` files (twelve hits) are temporary; they are tracked in BAL-596 and shrink to
 * zero there. The other categories are permanent and individually justified.
 */

const WEB_SRC = resolveRouteDir(['src', 'apps/web/src']);

const VIEW_TOKENS: readonly string[] = [
  'activeMode',
  'lens',
  'platformRole',
  'companyRole',
  'agencyRole',
  'role',
];

const CHAIN_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$.?';

function isChainChar(ch: string | undefined): boolean {
  return ch !== undefined && CHAIN_CHARS.includes(ch);
}

function isQuote(ch: string | undefined): ch is "'" | '"' {
  return ch === "'" || ch === '"';
}

function normalizeWhitespace(code: string): string {
  return code.replace(/\s+/g, ' ');
}

function lastSegment(operand: string): string {
  const segments = operand.split('.');
  return (segments[segments.length - 1] ?? '').replaceAll('?', '');
}

/** The operand ending just before `end` (exclusive): a quoted literal or an identifier chain. */
function operandBefore(code: string, end: number): string {
  let stop = end;
  if (code[stop - 1] === ' ') stop -= 1;
  const closing = code[stop - 1];
  if (isQuote(closing)) {
    const open = code.lastIndexOf(closing, stop - 2);
    return open === -1 ? '' : code.slice(open, stop);
  }
  let start = stop;
  while (start > 0 && isChainChar(code[start - 1])) start -= 1;
  return code.slice(start, stop);
}

/** The operand starting just after `from`: a quoted literal or an identifier chain. */
function operandAfter(code: string, from: number): string {
  let start = from;
  if (code[start] === ' ') start += 1;
  const opening = code[start];
  if (isQuote(opening)) {
    const close = code.indexOf(opening, start + 1);
    return close === -1 ? '' : code.slice(start, close + 1);
  }
  let stop = start;
  while (isChainChar(code[stop])) stop += 1;
  return code.slice(start, stop);
}

function isNullGuard(operand: string): boolean {
  return operand === 'undefined' || operand === 'null';
}

function isViewToken(operand: string): boolean {
  return !isQuote(operand[0]) && VIEW_TOKENS.includes(lastSegment(operand));
}

function comparisonsOf(code: string, operator: '===' | '!=='): string[] {
  const hits: string[] = [];
  let at = code.indexOf(operator);
  while (at !== -1) {
    const lhs = operandBefore(code, at);
    const rhs = operandAfter(code, at + operator.length);
    const tokenSide = isViewToken(lhs) || isViewToken(rhs);
    if (tokenSide && !isNullGuard(lhs) && !isNullGuard(rhs)) {
      hits.push(`${lhs} ${operator} ${rhs}`);
    }
    at = code.indexOf(operator, at + operator.length);
  }
  return hits;
}

function switchesOf(code: string): string[] {
  const hits: string[] = [];
  const marker = 'switch (';
  let at = code.indexOf(marker);
  while (at !== -1) {
    const close = code.indexOf(')', at + marker.length);
    if (close === -1) break;
    const subject = code.slice(at + marker.length, close).trim();
    if (isViewToken(subject)) hits.push(`switch (${subject})`);
    at = code.indexOf(marker, at + marker.length);
  }
  return hits;
}

/** Every role/lens/mode comparison or switch in `code`, as `"<lhs> <op> <rhs>"` / `"switch (<x>)"`. */
function viewGateComparisonsOf(code: string): string[] {
  const normalized = normalizeWhitespace(code);
  return [
    ...comparisonsOf(normalized, '==='),
    ...comparisonsOf(normalized, '!=='),
    ...switchesOf(normalized),
  ];
}

function isScanned(file: ScannedFile): boolean {
  return hasUseServerDirective(file.raw) || file.rel.startsWith('lib/actions/');
}

const ALL_SOURCES = scanRouteSources(WEB_SRC, '', []);
const SCANNED = ALL_SOURCES.filter(isScanned);

type ExclusionCategory =
  | 'deferred-bal-596'
  | 'redundant-routing-assertion'
  | 'notification-recipient-routing'
  | 'data-scoping';

interface ViewGateExclusion {
  /** Path relative to `apps/web/src`. */
  readonly file: string;
  readonly comparison: string;
  readonly count: number;
  readonly category: ExclusionCategory;
  readonly justification: string;
}

const DASH = 'app/(dashboard)/';
const PROJECT_ACTIONS = `${DASH}projects/[requestId]/_actions/`;
const CASE_ACTIONS = `${DASH}cases/[engagementId]/_actions/`;

const BAL_596 =
  "The derived lens is this action's sole gate; BAL-596 replaces it with a capability check and removes this entry.";
const ROUTING_ASSERTION = (capability: string): string =>
  `A redundant routing assertion; the ${capability} check that follows is the gate.`;

/**
 * Hand-audited against a fresh scan. `comparison` is the matcher's exact output; a missing or
 * extra hit fails the no-rot assertion, so the list cannot drift from the code.
 */
const EXCLUSIONS: readonly ViewGateExclusion[] = [
  ...(
    [
      ['request-proposal.ts', "access.ctx.lens !== 'client'"],
      ['request-proposal-changes.ts', "access.ctx.lens !== 'client'"],
      ['submit-billing-details.ts', "access.ctx.lens !== 'client'"],
      ['resubmit-proposal.ts', "access.ctx.lens !== 'expert'"],
      ['request-proposal-document-upload.ts', "access.ctx.lens !== 'expert'"],
      ['confirm-proposal-document-upload.ts', "access.ctx.lens !== 'expert'"],
      ['remove-proposal-document.ts', "access.ctx.lens !== 'expert'"],
      ['get-proposal-document-download.ts', "access.ctx.lens !== 'expert'"],
      ['withdraw-eoi.ts', "ctx.lens !== 'expert'"],
    ] as const satisfies readonly (readonly [string, string])[]
  ).map(
    ([name, comparison]): ViewGateExclusion => ({
      file: `${PROJECT_ACTIONS}${name}`,
      comparison,
      count: 1,
      category: 'deferred-bal-596',
      justification: BAL_596,
    })
  ),
  {
    file: `${DASH}projects/[requestId]/proposal/[relationshipId]/_actions/share.ts`,
    comparison: "ctx.lens === 'expert'",
    count: 1,
    category: 'deferred-bal-596',
    justification: BAL_596,
  },
  ...(
    [
      ['resolve-case.ts', "lens !== 'client'", 1, 'hasCapability(PARTICIPATE)'],
      ['dismiss-resolution-request.ts', "lens !== 'client'", 1, 'hasCapability(PARTICIPATE)'],
      [
        'request-resolution.ts',
        "lens !== 'expert'",
        1,
        'hasEngagementCapability(MANAGE_ENGAGEMENT)',
      ],
      [
        'propose-reschedule.ts',
        "gate.lens !== 'expert'",
        2,
        'hasEngagementCapability(MANAGE_ENGAGEMENT)',
      ],
      ['cancel-consultation.ts', "lens === 'client'", 1, 'hasCapability / hasEngagementCapability'],
    ] as const satisfies readonly (readonly [string, string, number, string])[]
  ).map(
    ([name, comparison, count, capability]): ViewGateExclusion => ({
      file: `${CASE_ACTIONS}${name}`,
      comparison,
      count,
      category: 'redundant-routing-assertion',
      justification: ROUTING_ASSERTION(capability),
    })
  ),
  ...(
    [
      ['post-conversation-message.ts', "access.recipient.role === 'client'"],
      ['post-conversation-message.ts', "access.recipient.role === 'expert'"],
      ['resubmit-proposal.ts', "access.recipient.role === 'client'"],
    ] as const satisfies readonly (readonly [string, string])[]
  ).map(
    ([name, comparison]): ViewGateExclusion => ({
      file: `${PROJECT_ACTIONS}${name}`,
      comparison,
      count: 1,
      category: 'notification-recipient-routing',
      justification:
        'Picks which recipient id field the notification payload carries; authorization was already resolved by resolveConversationAccess.',
    })
  ),
  {
    file: `${PROJECT_ACTIONS}create-conversation-realtime-token.ts`,
    comparison: "ctx.lens !== 'expert'",
    count: 1,
    category: 'data-scoping',
    justification:
      'Filters which relationships the realtime token covers after resolveRequestLens and its archetype === participant check have gated the caller.',
  },
];

function hitsIn(file: ScannedFile, comparison: string): number {
  return viewGateComparisonsOf(file.code).filter((hit) => hit === comparison).length;
}

function unexcludedViolations(
  files: readonly ScannedFile[],
  exclusions: readonly ViewGateExclusion[]
): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const budget = new Map<string, number>();
    for (const exclusion of exclusions) {
      if (exclusion.file === file.rel) budget.set(exclusion.comparison, exclusion.count);
    }
    for (const hit of viewGateComparisonsOf(file.code)) {
      const remaining = budget.get(hit) ?? 0;
      if (remaining > 0) {
        budget.set(hit, remaining - 1);
      } else {
        violations.push(`${file.rel}: ${hit}`);
      }
    }
  }
  return violations;
}

const CANCEL_CONSULTATION = `${CASE_ACTIONS}cancel-consultation.ts`;

const ADOPTERS: readonly string[] = [
  ...[
    'save-rate',
    'save-payout-details',
    'save-profile',
    'save-work-history',
    'save-certifications',
    'save-schedule',
    'update-schedule-timezone',
    'get-schedule',
    'clear-schedule',
    'check-username',
    'set-work-availability',
  ].map((name) => `${DASH}expert/settings/_actions/${name}.ts`),
  'lib/actions/expert-checklist.ts',
];

describe('BAL-438 — no Server Action authorizes by role / lens / activeMode', () => {
  it('scans a non-vacuous set that includes the lib/actions write path', () => {
    expect(SCANNED.length).toBeGreaterThanOrEqual(190);
    expect(SCANNED.map((file) => file.rel)).toContain('lib/actions/expert-checklist.ts');
    const directive = SCANNED.filter((file) => hasUseServerDirective(file.raw));
    expect(directive.length).toBeGreaterThanOrEqual(189);
  });

  it('extraction is live: a known case action yields its lens comparison', () => {
    const file = SCANNED.find((candidate) => candidate.rel === CANCEL_CONSULTATION);
    expect(file).toBeDefined();
    expect(viewGateComparisonsOf(file?.code ?? '')).toEqual(["lens === 'client'"]);
  });

  it('has no un-excluded role / lens / activeMode comparison', () => {
    expect(
      unexcludedViolations(SCANNED, EXCLUSIONS),
      'A Server Action compares a role, lens or activeMode. Authorize with hasCapability, ' +
        'hasEngagementCapability, hasPlatformCapability or resolveApprovedExpert (ADR-1029); ' +
        'activeMode is a view toggle, never an authorization input.'
    ).toEqual([]);
  });

  it('has no rotted exclusion: each matches exactly its recorded count of live hits', () => {
    for (const exclusion of EXCLUSIONS) {
      const file = SCANNED.find((candidate) => candidate.rel === exclusion.file);
      expect(file, `${exclusion.file} is no longer scanned`).toBeDefined();
      expect(
        file === undefined ? 0 : hitsIn(file, exclusion.comparison),
        `${exclusion.file}: ${exclusion.comparison}`
      ).toBe(exclusion.count);
    }
  });

  it('keeps every exclusion honest by category', () => {
    for (const exclusion of EXCLUSIONS) {
      expect(exclusion.justification.trim()).not.toBe('');
      if (exclusion.category === 'deferred-bal-596') {
        expect(exclusion.justification).toContain('BAL-596');
      }
      if (exclusion.category === 'redundant-routing-assertion') {
        const file = SCANNED.find((candidate) => candidate.rel === exclusion.file);
        const code = normalizeWhitespace(file?.code ?? '');
        const lastCall = Math.max(
          code.lastIndexOf('hasCapability('),
          code.lastIndexOf('hasEngagementCapability(')
        );
        let at = code.indexOf(exclusion.comparison);
        expect(at, `${exclusion.file} no longer contains its excluded comparison`).not.toBe(-1);
        while (at !== -1) {
          expect(
            lastCall,
            `${exclusion.file}: a capability call must follow every excluded comparison`
          ).toBeGreaterThan(at);
          at = code.indexOf(exclusion.comparison, at + exclusion.comparison.length);
        }
      }
    }
  });

  it('pins the shared approved-expert guard as the one definition', () => {
    const missing = ADOPTERS.filter((rel) => {
      const file = ALL_SOURCES.find((candidate) => candidate.rel === rel);
      return file === undefined || !file.code.includes('resolveApprovedExpert(');
    });
    expect(missing, 'each adopter must gate on resolveApprovedExpert(').toEqual([]);
    const duplicates = ALL_SOURCES.filter((file) => file.code.includes('function requireExpert('));
    expect(duplicates.map((file) => file.rel)).toEqual([]);
  });

  it('flags every view-gate spelling (guards the guard)', () => {
    const flagged: readonly (readonly [string, string])[] = [
      ["if (session.user.activeMode !== 'expert') return;", "session.user.activeMode !== 'expert'"],
      ["if ('expert' === ctx.lens) return;", "'expert' === ctx.lens"],
      ["if (user?.platformRole === 'admin') return;", "user?.platformRole === 'admin'"],
      ["if (member.agencyRole !== 'owner') return;", "member.agencyRole !== 'owner'"],
      ["if (session.user.companyRole === 'owner') return;", "session.user.companyRole === 'owner'"],
      ["if (row.role === 'admin') return;", "row.role === 'admin'"],
      ["if (role !== 'owner') return;", "role !== 'owner'"],
      ['switch (ctx.lens) { default: break; }', 'switch (ctx.lens)'],
      ["if (\n  a.lens\n  !==\n  'x'\n) { /* probe */ }", "a.lens !== 'x'"],
    ];
    for (const [source, hit] of flagged) {
      expect(viewGateComparisonsOf(source), source).toEqual([hit]);
    }
  });

  it('does not flag null-guards, resolver output or data (guards the guard)', () => {
    const clean = [
      'if (x.lens === undefined) return;',
      'if (null !== user.companyRole) return;',
      "if (access.side === 'client') return;",
      "if (access.viewer !== 'guest') return;",
      "const grant = { role: 'admin' };",
      'const label = ROLE_LABELS[role];',
      "if (lensLabel === 'x') return;",
    ];
    for (const source of clean) {
      expect(viewGateComparisonsOf(source), source).toEqual([]);
    }
  });

  it('goes red when a violation is introduced (automated red-fail proof)', () => {
    const raw =
      "'use server';\nexport async function probe(session) {\n  if (session.user.activeMode !== 'expert') return;\n}\n";
    const probe: ScannedFile = {
      rel: 'synthetic/_actions/probe.ts',
      raw,
      code: codeLinesOf(raw),
    };
    expect(isScanned(probe)).toBe(true);
    expect(unexcludedViolations([...SCANNED, probe], EXCLUSIONS)).toEqual(
      unexcludedViolations(SCANNED, EXCLUSIONS).concat([
        "synthetic/_actions/probe.ts: session.user.activeMode !== 'expert'",
      ])
    );
  });
});
