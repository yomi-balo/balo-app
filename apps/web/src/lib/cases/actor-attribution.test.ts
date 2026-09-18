import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_VIEWER_LABEL,
  attributionNamesViewer,
  proposalPendingTitle,
  resolutionAskPendingTitle,
  resolveActorLabel,
  type ActorAttributionInput,
} from './actor-attribution';

/**
 * BAL-567 — the attribution rule, as a FULL CROSS PRODUCT over the two sides and the four
 * actor identities, each asserting the EXACT rendered string.
 *
 * ⚠ EXACT STRINGS, NEVER `toContain`. The whole defect this rule fixes was a surface saying
 * "You've asked" to somebody who did not ask — a substring assertion on "asked" would have
 * passed for the bug.
 */

const VIEWER = 'user-viewer';
const DELIVERING_EXPERT = 'user-expert';
const COLLEAGUE = 'user-colleague';

function input(overrides: Partial<ActorAttributionInput>): ActorAttributionInput {
  return {
    side: 'client',
    actorUserId: DELIVERING_EXPERT,
    actorFirstName: 'Dana',
    viewerUserId: VIEWER,
    deliveringExpertUserId: DELIVERING_EXPERT,
    agencyName: 'CloudPeak',
    partyFallbackLabel: 'CloudPeak',
    ...overrides,
  };
}

interface AttributionCase {
  readonly name: string;
  readonly overrides: Partial<ActorAttributionInput>;
  readonly expected: string;
}

const CASES: readonly AttributionCase[] = [
  {
    name: 'client side · the delivering expert → their bare first name',
    overrides: { side: 'client', actorUserId: DELIVERING_EXPERT, actorFirstName: 'Dana' },
    expected: 'Dana',
  },
  {
    name: 'client side · an agency colleague → "{First name} @ {Agency}"',
    overrides: { side: 'client', actorUserId: COLLEAGUE, actorFirstName: 'Priya' },
    expected: 'Priya @ CloudPeak',
  },
  {
    name: 'client side · a colleague on an INDEPENDENT expert’s case → the party, no duplicate',
    overrides: {
      side: 'client',
      actorUserId: COLLEAGUE,
      actorFirstName: 'Priya',
      agencyName: null,
      partyFallbackLabel: 'Priya',
    },
    expected: 'Priya',
  },
  {
    name: 'client side · no actor id → the party label',
    overrides: { side: 'client', actorUserId: null },
    expected: 'CloudPeak',
  },
  {
    name: 'client side · an unreadable name → the party label',
    overrides: { side: 'client', actorUserId: COLLEAGUE, actorFirstName: null },
    expected: 'CloudPeak',
  },
  {
    name: 'client side · a BLANK name is as unreadable as a null one',
    overrides: { side: 'client', actorUserId: COLLEAGUE, actorFirstName: '   ' },
    expected: 'CloudPeak',
  },
  {
    name: 'expert side · the viewer themselves → "You"',
    overrides: { side: 'expert', actorUserId: VIEWER, actorFirstName: 'Sam' },
    expected: 'You',
  },
  {
    name: 'expert side · a colleague → their bare first name, never "You"',
    overrides: { side: 'expert', actorUserId: COLLEAGUE, actorFirstName: 'Priya' },
    expected: 'Priya',
  },
  {
    // ⚠ IDENTITY BEATS NAMING. An expert whose own `first_name` is blank (routine for an SSO
    // profile carrying only a full name) still read their OWN ask as "You", not as the agency.
    name: 'expert side · the viewer with a BLANK name → still "You", not the party label',
    overrides: { side: 'expert', actorUserId: VIEWER, actorFirstName: null },
    expected: 'You',
  },
  {
    name: 'expert side · the viewer with a WHITESPACE-ONLY name → still "You"',
    overrides: { side: 'expert', actorUserId: VIEWER, actorFirstName: '   ' },
    expected: 'You',
  },
  {
    name: 'expert side · the delivering expert, viewed by a colleague → their first name',
    overrides: { side: 'expert', actorUserId: DELIVERING_EXPERT, actorFirstName: 'Dana' },
    expected: 'Dana',
  },
  {
    name: 'expert side · no readable actor → the party label, never "You"',
    overrides: { side: 'expert', actorUserId: null, actorFirstName: null },
    expected: 'CloudPeak',
  },
];

describe('resolveActorLabel', () => {
  it('covers every documented arm of the rule (guards a shrunken table)', () => {
    expect(CASES).toHaveLength(12);
  });

  it.each(CASES)('$name', ({ overrides, expected }) => {
    expect(resolveActorLabel(input(overrides))).toBe(expected);
  });

  it('never names the CLIENT viewer "You", even when the ids collide', () => {
    // Structurally impossible through the loaders (every attributed actor is expert-side), but
    // the arm must be decided by SIDE, not by an id comparison that happens to fail.
    const label = resolveActorLabel(
      input({ side: 'client', actorUserId: VIEWER, actorFirstName: 'Sam' })
    );
    expect(label).not.toBe(ATTRIBUTION_VIEWER_LABEL);
    expect(label).toBe('Sam @ CloudPeak');
  });

  it('trims the rendered name rather than emitting the padding', () => {
    expect(resolveActorLabel(input({ side: 'expert', actorFirstName: '  Dana  ' }))).toBe('Dana');
  });
});

describe('attributionNamesViewer', () => {
  it('recognises only the exact viewer label', () => {
    expect(attributionNamesViewer(ATTRIBUTION_VIEWER_LABEL)).toBe(true);
    expect(attributionNamesViewer('You @ CloudPeak')).toBe(false);
    expect(attributionNamesViewer('Priya')).toBe(false);
  });
});

describe('the two shared sentence builders', () => {
  it('contracts the resolution ask only for the viewer', () => {
    expect(resolutionAskPendingTitle(ATTRIBUTION_VIEWER_LABEL)).toBe(
      "You've asked if this is sorted"
    );
    expect(resolutionAskPendingTitle('Priya')).toBe('Priya asked if this is sorted');
    expect(resolutionAskPendingTitle('CloudPeak')).toBe('CloudPeak asked if this is sorted');
  });

  it('reads naturally for both the viewer and a colleague on a pending proposal', () => {
    expect(proposalPendingTitle(ATTRIBUTION_VIEWER_LABEL)).toBe('You suggested new times');
    expect(proposalPendingTitle('Priya')).toBe('Priya suggested new times');
  });
});
