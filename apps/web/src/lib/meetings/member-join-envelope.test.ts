import { describe, expect, it } from 'vitest';
import { parseMemberJoinEnvelope } from './member-join-envelope';

/**
 * BAL-435 (R6 + R10) — the response envelope, parsed rather than cast.
 *
 * ⚠⚠ WHAT THIS PREVENTS, CONCRETELY: `join-api-client.ts` ends with `parsed as T`, and
 * `back-to-context.ts`'s table is TOTAL at COMPILE time with no `default:` arm. An unexpected
 * `context.type` was therefore `undefined(...)` — a TypeError on the join path, tripping the
 * error boundary and denying somebody their live call, on the surface where failing is most
 * expensive.
 *
 * ⚠ AND NOTHING HERE MAY EVER REFUSE A CALL. Each field degrades on its own; the GRANT is
 * validated separately, at `MeetingCallSurface`, and that is the check with the authority to say
 * no.
 */

const CONTEXT_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
/** ⚠ BAL-567 — deliberately DIFFERENT from {@link CONTEXT_ID}: the whole point is the two ids. */
const REQUEST_ID = '5c8e2b41-7a6d-4f3e-9b2a-1d0c8e7f6a5b';

const FULL = {
  roomUrl: 'https://balo.daily.co/x',
  token: 'jwt',
  isOwner: false,
  expiresAt: '2026-09-02T11:00:00.000Z',
  participantId: 'u0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d',
  context: { type: 'case', id: CONTEXT_ID, title: 'Salesforce flow review' },
  viewerRole: 'client',
  counterpartyFirstName: 'Dana',
  scheduledStart: '2026-09-02T10:00:00.000Z',
};

describe('parseMemberJoinEnvelope — the happy path', () => {
  it('reads all four fields', () => {
    expect(parseMemberJoinEnvelope(FULL)).toEqual({
      // ⚠ BAL-567 — `projectRequestId` is `null` on a `case`: the field is a request-grain link
      // target, and a case has no request. `null` is the answer, not an absence.
      context: {
        type: 'case',
        id: CONTEXT_ID,
        title: 'Salesforce flow review',
        projectRequestId: null,
      },
      viewerRole: 'client',
      counterpartyFirstName: 'Dana',
      scheduledStart: '2026-09-02T10:00:00.000Z',
    });
  });

  /**
   * BAL-567 — the request-grain link target rides the envelope.
   *
   * ⚠ IT DEGRADES TO `null`, NOT TO `id`. A body from an API build that predates the field must
   * lose only the back link, never gain a WRONG one: on `request_interaction` the `id` is a
   * `request_expert_relationships.id`, so substituting it would reinstate the exact bug this
   * field exists to remove.
   */
  it('BAL-567 — carries a resolved projectRequestId, and degrades it to null rather than to id', () => {
    const withTarget = parseMemberJoinEnvelope({
      ...FULL,
      context: {
        type: 'request_interaction',
        id: CONTEXT_ID,
        title: 'Migrate to Flow',
        projectRequestId: REQUEST_ID,
      },
    });
    expect(withTarget.context?.projectRequestId).toBe(REQUEST_ID);
    expect(withTarget.context?.id).toBe(CONTEXT_ID);

    const withoutTarget = parseMemberJoinEnvelope({
      ...FULL,
      context: { type: 'request_interaction', id: CONTEXT_ID, title: 'Migrate to Flow' },
    });
    expect(withoutTarget.context?.projectRequestId).toBeNull();
    // The rest of the context still parses — losing the target must not cost the heading.
    expect(withoutTarget.context?.title).toBe('Migrate to Flow');
  });

  it('accepts every holder-bearing context type', () => {
    for (const type of [
      'case',
      'project_discovery',
      'project_kickoff',
      'package_session',
      'retainer_checkin',
      'request_interaction',
    ]) {
      const parsed = parseMemberJoinEnvelope({ ...FULL, context: { type, id: CONTEXT_ID } });
      expect(parsed.context?.type).toBe(type);
      // ⚠ A missing title is `null`, a first-class answer: three of the six shapes have no title
      // column anywhere.
      expect(parsed.context?.title).toBeNull();
    }
  });

  it('accepts both viewer roles and nothing else', () => {
    expect(parseMemberJoinEnvelope({ viewerRole: 'expert' }).viewerRole).toBe('expert');
    expect(parseMemberJoinEnvelope({ viewerRole: 'client' }).viewerRole).toBe('client');
    expect(parseMemberJoinEnvelope({ viewerRole: 'admin' }).viewerRole).toBeNull();
    expect(parseMemberJoinEnvelope({ viewerRole: true }).viewerRole).toBeNull();
  });
});

describe('parseMemberJoinEnvelope — ⚠⚠ every field degrades on its own', () => {
  it('an UNKNOWN context type yields null instead of an undefined table lookup', () => {
    // ⚠ THE TYPEERROR THIS EXISTS TO STOP. A seventh `meeting_context_type` added server-side, a
    // proxy injecting a body, or a schema drift used to crash the join path.
    const parsed = parseMemberJoinEnvelope({ ...FULL, context: { type: 'admin', id: CONTEXT_ID } });

    expect(parsed.context).toBeNull();
    // ⚠ AND IT COSTS THE VIEWER NOTHING ELSE.
    expect(parsed.viewerRole).toBe('client');
    expect(parsed.counterpartyFirstName).toBe('Dana');
  });

  it('a non-uuid context id yields null', () => {
    expect(
      parseMemberJoinEnvelope({ context: { type: 'case', id: '../../etc' } }).context
    ).toBeNull();
  });

  it('a malformed viewerRole does not cost the context', () => {
    const parsed = parseMemberJoinEnvelope({ ...FULL, viewerRole: 'both' });

    expect(parsed.viewerRole).toBeNull();
    expect(parsed.context?.type).toBe('case');
  });

  it('an unparseable scheduledStart is null, never a wrong time on a money surface', () => {
    expect(parseMemberJoinEnvelope({ scheduledStart: 'soon' }).scheduledStart).toBeNull();
    expect(parseMemberJoinEnvelope({ scheduledStart: '' }).scheduledStart).toBeNull();
    expect(parseMemberJoinEnvelope({ scheduledStart: 42 }).scheduledStart).toBeNull();
  });

  it('a blank counterparty name is null, not an empty {Name} in the copy', () => {
    expect(
      parseMemberJoinEnvelope({ counterpartyFirstName: '   ' }).counterpartyFirstName
    ).toBeNull();
    expect(
      parseMemberJoinEnvelope({ counterpartyFirstName: null }).counterpartyFirstName
    ).toBeNull();
  });

  it('trims a padded name rather than rendering the padding', () => {
    expect(parseMemberJoinEnvelope({ counterpartyFirstName: ' Dana ' }).counterpartyFirstName).toBe(
      'Dana'
    );
  });
});

describe('parseMemberJoinEnvelope — ⚠ the guest shape is a LIVE path, not a failure', () => {
  it('a bare grant (both guest mounts) yields all nulls', () => {
    expect(
      parseMemberJoinEnvelope({
        roomUrl: 'https://balo.daily.co/x',
        token: 'jwt',
        isOwner: false,
        expiresAt: '2026-09-02T11:00:00.000Z',
        participantId: 'g0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d',
      })
    ).toEqual({
      context: null,
      viewerRole: null,
      counterpartyFirstName: null,
      scheduledStart: null,
    });
  });

  it('never throws on garbage', () => {
    for (const raw of [null, undefined, 'a string', 42, [], { context: 'not an object' }]) {
      expect(() => parseMemberJoinEnvelope(raw)).not.toThrow();
      expect(parseMemberJoinEnvelope(raw).context).toBeNull();
    }
  });
});
