import { describe, expect, it } from 'vitest';
import { DECLINABLE_RELATIONSHIP_STATUSES } from '@balo/shared/project-requests';
import {
  RELATIONSHIP_STATUS_TRANSITIONS,
  type RelationshipStatus,
} from '../repositories/request-expert-relationships';

/**
 * BAL-540 (fix round) — structural invariant: `@balo/shared/project-requests`'
 * `DECLINABLE_RELATIONSHIP_STATUSES` is EXACTLY the set of relationship statuses whose
 * `RELATIONSHIP_STATUS_TRANSITIONS` entry carries a `'declined'` edge.
 *
 * WHY THIS TEST EXISTS. That tuple is the single definition of "declinable stage" for six
 * modules across four packages (both decline Server Actions, `close-copy.ts`, `thread-actions.ts`,
 * `request-detail-view.ts`, the two notification payloads and the analytics event map). It lives
 * in `@balo/shared` because client islands cannot value-import `@balo/db` — which means the
 * TYPE system can only prove the weaker "every declinable stage is a real relationship status"
 * (`declinableRelationshipStatusAgreement`, pinned in the repository). This is the other half:
 * the VALUE-level proof that the tuple neither omits a declinable status nor invents one.
 *
 * A seventh `request_expert_relationship_status` given a `'declined'` edge without joining the
 * shared tuple fails HERE, instead of silently rendering as an unlabelled stage.
 *
 * Modelled on `meeting-transitions-match-the-cas.test.ts`, the same shape for meetings.
 */
describe('invariant: DECLINABLE_RELATIONSHIP_STATUSES matches RELATIONSHIP_STATUS_TRANSITIONS', () => {
  const sourcesWithADeclinedEdge = (
    Object.keys(RELATIONSHIP_STATUS_TRANSITIONS) as RelationshipStatus[]
  ).filter((from) => RELATIONSHIP_STATUS_TRANSITIONS[from].includes('declined'));

  it('collects a non-empty transition map (guards against a vacuous pass)', () => {
    expect(Object.keys(RELATIONSHIP_STATUS_TRANSITIONS).length).toBeGreaterThan(0);
    expect(sourcesWithADeclinedEdge.length).toBeGreaterThan(0);
  });

  it('is exactly the set of statuses a track can be declined FROM', () => {
    expect([...DECLINABLE_RELATIONSHIP_STATUSES].sort()).toEqual(
      [...sourcesWithADeclinedEdge].sort()
    );
  });

  it('never names a terminal status (accepted / declined are not declinable)', () => {
    const declinable: readonly string[] = DECLINABLE_RELATIONSHIP_STATUSES;
    expect(declinable).not.toContain('accepted');
    expect(declinable).not.toContain('declined');
  });
});
