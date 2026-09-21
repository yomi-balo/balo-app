import { describe, expect, it } from 'vitest';
import {
  conversationSubjectForMeetingContext,
  type ConversationSubject,
} from '@balo/shared/conversations';
import {
  MEETING_CONTEXT_PRECEDENCE,
  type MeetingContextTypeWithHolder,
} from '@balo/shared/meetings';
import { meetingContextTypesForEnvelope } from './envelope-context-types';

const CONTEXT_ID = 'e0000000-0000-4000-8000-000000000001';

/** Every `MeetingContextTypeWithHolder` label, derived from the precedence map — never a
 *  hand-typed array that could silently drift from the pgEnum restatement. */
const HOLDER_LABELS = Object.keys(MEETING_CONTEXT_PRECEDENCE).filter(
  (label): label is MeetingContextTypeWithHolder => label !== 'admin'
);

describe('meetingContextTypesForEnvelope', () => {
  /**
   * THE ROUND-TRIP PROPERTY. The `AssertNever` pins only catch a label ADDED to the pgEnum,
   * never one RE-ANCHORED between arms of the forward map, so this test derives its
   * expectation from `conversationSubjectForMeetingContext` itself rather than restating it.
   */
  it('round-trips every MeetingContextTypeWithHolder label through the forward map', () => {
    expect(HOLDER_LABELS).toHaveLength(6); // pairs the predicate below with a length assertion
    let nullArmFired = 0;

    for (const contextType of HOLDER_LABELS) {
      const envelope = conversationSubjectForMeetingContext({ contextType, contextId: CONTEXT_ID });
      if (envelope === null) {
        nullArmFired += 1;
        // project_discovery names no envelope — it must appear in NEITHER arm.
        expect(
          meetingContextTypesForEnvelope({ contextType: 'engagement', contextId: CONTEXT_ID })
        ).not.toContainEqual({ contextType, contextId: CONTEXT_ID });
        expect(
          meetingContextTypesForEnvelope({ contextType: 'relationship', contextId: CONTEXT_ID })
        ).not.toContainEqual({ contextType, contextId: CONTEXT_ID });
        continue;
      }
      expect(meetingContextTypesForEnvelope(envelope)).toContainEqual({
        contextType,
        contextId: CONTEXT_ID,
      });
    }

    // Exactly one label (project_discovery) maps to null — otherwise a shrunken label list
    // (or a forward-map regression) would pass this test vacuously.
    expect(nullArmFired).toBe(1);
  });

  it("'engagement' envelope returns exactly the four engagement-grain types, all on the one contextId", () => {
    const result = meetingContextTypesForEnvelope({
      contextType: 'engagement',
      contextId: CONTEXT_ID,
    });
    expect(result).toHaveLength(4);
    expect([...result].sort((a, b) => a.contextType.localeCompare(b.contextType))).toEqual([
      { contextType: 'case', contextId: CONTEXT_ID },
      { contextType: 'package_session', contextId: CONTEXT_ID },
      { contextType: 'project_kickoff', contextId: CONTEXT_ID },
      { contextType: 'retainer_checkin', contextId: CONTEXT_ID },
    ]);
  });

  it("'relationship' envelope returns exactly [request_interaction]", () => {
    const result = meetingContextTypesForEnvelope({
      contextType: 'relationship',
      contextId: CONTEXT_ID,
    });
    expect(result).toHaveLength(1);
    expect(result).toEqual([{ contextType: 'request_interaction', contextId: CONTEXT_ID }]);
  });

  /**
   * THE RUNTIME HALF OF THE EXHAUSTIVENESS GUARD. `AssertEnvelopeContextTypesComplete` and the
   * `switch`'s `never` default both fail `tsc` on a real new label, so the only way to reach the
   * `default:` arm at runtime is a caller that bypasses the compiler entirely (a bad cast, or an
   * envelope built from unvalidated external input). Exercising it here proves the function
   * fails LOUDLY — by returning the offending value itself, never a silent `[]` a caller could
   * mistake for "no other meetings" — rather than relying on the type system alone.
   */
  it('an envelope with an impossible contextType (compiler bypassed) reaches the default arm and echoes the bad value back, never a silent []', () => {
    const bogus = {
      contextType: 'not-a-real-context-type',
      contextId: CONTEXT_ID,
    } as unknown as ConversationSubject;

    const result = meetingContextTypesForEnvelope(bogus);

    expect(result).toBe('not-a-real-context-type');
  });
});
