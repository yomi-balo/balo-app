import { describe, expect, it } from 'vitest';
// Imported from `@balo/db/schema` (the schema subpath, never the package root) so this pin costs
// nothing but the two pgEnums — the planner itself may not import `@balo/db` at all.
import { projectRequestStatusEnum, requestExpertRelationshipStatusEnum } from '@balo/db/schema';
import {
  FAST_FORWARD_TARGETS,
  planFastForward,
  reachableTargets,
  refusalCopy,
  type FastForwardTarget,
  type PlanRefusal,
} from './fast-forward-plan';

describe('planFastForward', () => {
  describe('closed request — terminal for every target', () => {
    it('refuses request_closed for every target (non-vacuity: full sweep + length)', () => {
      const refusals = FAST_FORWARD_TARGETS.map((target) => planFastForward('closed', target));
      expect(refusals).toHaveLength(FAST_FORWARD_TARGETS.length);
      for (const result of refusals) {
        expect(result).toEqual({ ok: false, refusal: 'request_closed' });
      }
    });
  });

  describe('target: closed', () => {
    it('closes from every non-terminal stage before accepted', () => {
      const closable = [
        'draft',
        'requested',
        'exploratory_meeting_requested',
        'experts_invited',
        'eoi_submitted',
        'proposal_requested',
        'proposal_submitted',
      ];
      const results = closable.map((status) => planFastForward(status, 'closed'));
      expect(results).toHaveLength(closable.length);
      for (const result of results) {
        expect(result).toEqual({ ok: true, steps: ['close'] });
      }
    });

    it('refuses close_refused_at_stage from accepted', () => {
      expect(planFastForward('accepted', 'closed')).toEqual({
        ok: false,
        refusal: 'close_refused_at_stage',
      });
    });

    it('refuses close_refused_at_stage from kickoff_approved', () => {
      expect(planFastForward('kickoff_approved', 'closed')).toEqual({
        ok: false,
        refusal: 'close_refused_at_stage',
      });
    });
  });

  describe('target: declined_track', () => {
    it('always proposes decline_track, regardless of the current (non-closed) status', () => {
      const statuses = [
        'requested',
        'exploratory_meeting_requested',
        'experts_invited',
        'eoi_submitted',
        'proposal_requested',
        'proposal_submitted',
        'accepted',
        'kickoff_approved',
      ];
      const results = statuses.map((status) => planFastForward(status, 'declined_track'));
      expect(results).toHaveLength(statuses.length);
      for (const result of results) {
        expect(result).toEqual({ ok: true, steps: ['decline_track'] });
      }
    });
  });

  describe('spine targets', () => {
    it('refuses off_spine from draft for every spine target', () => {
      const spineTargets: FastForwardTarget[] = [
        'experts_invited',
        'eoi_submitted',
        'proposal_requested',
        'proposal_submitted',
        'accepted',
      ];
      const results = spineTargets.map((target) => planFastForward('draft', target));
      expect(results).toHaveLength(spineTargets.length);
      for (const result of results) {
        expect(result).toEqual({ ok: false, refusal: 'off_spine' });
      }
    });

    it('refuses off_spine from an unrecognised status (defensive)', () => {
      expect(planFastForward('not_a_real_status', 'accepted')).toEqual({
        ok: false,
        refusal: 'off_spine',
      });
    });

    it('produces the full step run from requested to accepted', () => {
      expect(planFastForward('requested', 'accepted')).toEqual({
        ok: true,
        steps: ['invite', 'eoi', 'request_proposal', 'submit_proposal', 'accept'],
      });
    });

    it('produces only the remaining steps when starting mid-spine', () => {
      expect(planFastForward('experts_invited', 'accepted')).toEqual({
        ok: true,
        steps: ['eoi', 'request_proposal', 'submit_proposal', 'accept'],
      });
      expect(planFastForward('proposal_requested', 'accepted')).toEqual({
        ok: true,
        steps: ['submit_proposal', 'accept'],
      });
    });

    it('produces a single step when the target is the very next stage', () => {
      expect(planFastForward('requested', 'experts_invited')).toEqual({
        ok: true,
        steps: ['invite'],
      });
      expect(planFastForward('experts_invited', 'eoi_submitted')).toEqual({
        ok: true,
        steps: ['eoi'],
      });
    });

    it('exploratory_meeting_requested ranks EQUAL to requested', () => {
      const fromRequested = planFastForward('requested', 'proposal_submitted');
      const fromExploratory = planFastForward(
        'exploratory_meeting_requested',
        'proposal_submitted'
      );
      expect(fromExploratory).toEqual(fromRequested);
      expect(fromExploratory).toEqual({
        ok: true,
        steps: ['invite', 'eoi', 'request_proposal', 'submit_proposal'],
      });
    });

    it('refuses already_at_or_past when the request is exactly at the target', () => {
      // NOT `experts_invited` → `experts_invited`: that pair sits inside the INVITE WINDOW, which
      // is planned by membership rather than by rank (the F1(b) block below owns it).
      expect(planFastForward('proposal_requested', 'proposal_requested')).toEqual({
        ok: false,
        refusal: 'already_at_or_past',
      });
      expect(planFastForward('accepted', 'accepted')).toEqual({
        ok: false,
        refusal: 'already_at_or_past',
      });
    });

    it('refuses already_at_or_past when the request is past the target', () => {
      expect(planFastForward('accepted', 'experts_invited')).toEqual({
        ok: false,
        refusal: 'already_at_or_past',
      });
      expect(planFastForward('proposal_submitted', 'eoi_submitted')).toEqual({
        ok: false,
        refusal: 'already_at_or_past',
      });
    });

    it('refuses already_at_or_past for every spine target once kickoff_approved (past accepted)', () => {
      const spineTargets: FastForwardTarget[] = [
        'experts_invited',
        'eoi_submitted',
        'proposal_requested',
        'proposal_submitted',
        'accepted',
      ];
      const results = spineTargets.map((target) => planFastForward('kickoff_approved', target));
      expect(results).toHaveLength(spineTargets.length);
      for (const result of results) {
        expect(result).toEqual({ ok: false, refusal: 'already_at_or_past' });
      }
    });
  });
});

describe('F1(b) — the invite window is REQUEST grain, planned by membership, not by rank', () => {
  /** Mirrors `INVITE_WINDOW_STATUSES` (`invite-experts.ts`) — the statuses a real invite accepts. */
  const INVITE_WINDOW = [
    'requested',
    'exploratory_meeting_requested',
    'experts_invited',
    'eoi_submitted',
  ];

  it('plans a single invite from EVERY in-window status, so a SECOND expert stays invitable', () => {
    const results = INVITE_WINDOW.map((status) => planFastForward(status, 'experts_invited'));
    expect(results).toHaveLength(INVITE_WINDOW.length);
    for (const result of results) {
      expect(result).toEqual({ ok: true, steps: ['invite'] });
    }
  });

  it('refuses outside the window (non-vacuity: the window is a real boundary, not a blanket ok)', () => {
    const outOfWindow = [
      'proposal_requested',
      'proposal_submitted',
      'accepted',
      'kickoff_approved',
    ];
    const results = outOfWindow.map((status) => planFastForward(status, 'experts_invited'));
    expect(results).toHaveLength(outOfWindow.length);
    for (const result of results) {
      expect(result).toEqual({ ok: false, refusal: 'already_at_or_past' });
    }
    // The two non-rank branches still win over the window.
    expect(planFastForward('draft', 'experts_invited')).toEqual({
      ok: false,
      refusal: 'off_spine',
    });
    expect(planFastForward('closed', 'experts_invited')).toEqual({
      ok: false,
      refusal: 'request_closed',
    });
  });

  it('never plans an invite once a TRACK is selected — `invite` creates a track, it never advances one', () => {
    const results = INVITE_WINDOW.map((status) =>
      planFastForward(status, 'experts_invited', 'invited')
    );
    expect(results).toHaveLength(INVITE_WINDOW.length);
    for (const result of results) {
      expect(result).toEqual({ ok: false, refusal: 'already_at_or_past' });
    }
  });
});

describe('F1 — track grain: the spine follows the SELECTED track, not the request rollup', () => {
  it('(a) a LAGGING track can catch up, where the request-grain rollup refused it outright', () => {
    // Fixture: track A reached `proposal_submitted` (so the request rollup reads
    // `proposal_submitted`), track B is still at `invited`. Planning B at request grain refuses.
    expect(planFastForward('proposal_submitted', 'eoi_submitted', 'invited')).toEqual({
      ok: true,
      steps: ['eoi'],
    });
    expect(planFastForward('proposal_submitted', 'proposal_submitted', 'invited')).toEqual({
      ok: true,
      steps: ['eoi', 'request_proposal', 'submit_proposal'],
    });
    expect(planFastForward('proposal_submitted', 'accepted', 'invited')).toEqual({
      ok: true,
      steps: ['eoi', 'request_proposal', 'submit_proposal', 'accept'],
    });
  });

  it('(a) non-vacuity — the SAME request status at REQUEST grain still refuses / shortens', () => {
    expect(planFastForward('proposal_submitted', 'eoi_submitted')).toEqual({
      ok: false,
      refusal: 'already_at_or_past',
    });
    expect(planFastForward('proposal_submitted', 'proposal_submitted')).toEqual({
      ok: false,
      refusal: 'already_at_or_past',
    });
    expect(planFastForward('proposal_submitted', 'accepted')).toEqual({
      ok: true,
      steps: ['accept'],
    });
  });

  it('(c) never drops a step the chosen track still needs (the BAL-315 admin bypass made this silent)', () => {
    // Request at `eoi_submitted` because ANOTHER track submitted an EOI; this track is `invited`.
    // Request grain plans `request_proposal` first — which SUCCEEDS from `invited` under the
    // BAL-315 admin bypass — leaving a track at `proposal_submitted` that never submitted an EOI.
    expect(planFastForward('eoi_submitted', 'proposal_submitted')).toEqual({
      ok: true,
      steps: ['request_proposal', 'submit_proposal'],
    });
    expect(planFastForward('eoi_submitted', 'proposal_submitted', 'invited')).toEqual({
      ok: true,
      steps: ['eoi', 'request_proposal', 'submit_proposal'],
    });
  });

  it('ranks every live relationship status, each producing exactly the steps above it', () => {
    const expectations: ReadonlyArray<readonly [string, readonly string[]]> = [
      ['invited', ['eoi', 'request_proposal', 'submit_proposal', 'accept']],
      ['eoi_submitted', ['request_proposal', 'submit_proposal', 'accept']],
      ['proposal_requested', ['submit_proposal', 'accept']],
      ['proposal_submitted', ['accept']],
    ];
    const results = expectations.map(([trackStatus]) =>
      planFastForward('requested', 'accepted', trackStatus)
    );
    expect(results).toHaveLength(expectations.length);
    expectations.forEach(([, steps], index) => {
      expect(results[index]).toEqual({ ok: true, steps });
    });
    // The top of the ladder has nothing left to run.
    expect(planFastForward('requested', 'accepted', 'accepted')).toEqual({
      ok: false,
      refusal: 'already_at_or_past',
    });
  });

  it('refuses track_declined for every spine target on a declined track (never off_spine)', () => {
    const spineTargets: FastForwardTarget[] = [
      'experts_invited',
      'eoi_submitted',
      'proposal_requested',
      'proposal_submitted',
      'accepted',
    ];
    const results = spineTargets.map((target) =>
      planFastForward('proposal_submitted', target, 'declined')
    );
    expect(results).toHaveLength(spineTargets.length);
    for (const result of results) {
      expect(result).toEqual({ ok: false, refusal: 'track_declined' });
    }
  });

  it('refuses off_spine for an unrecognised TRACK status (defensive, mirrors the request arm)', () => {
    expect(planFastForward('requested', 'accepted', 'not_a_real_relationship_status')).toEqual({
      ok: false,
      refusal: 'off_spine',
    });
  });

  it('`closed` and `declined_track` stay REQUEST grain even with a track selected', () => {
    // RISK 1: an `accepted` request carrying a live `invited` track must NOT start offering
    // `closed` — `STATUS_TRANSITIONS` has no `accepted → closed` edge, and this planner mirrors
    // that refusal rather than inventing around it.
    expect(planFastForward('accepted', 'closed', 'invited')).toEqual({
      ok: false,
      refusal: 'close_refused_at_stage',
    });
    expect(planFastForward('accepted', 'closed')).toEqual({
      ok: false,
      refusal: 'close_refused_at_stage',
    });
    // …and a mid-spine request still closes with a track selected.
    expect(planFastForward('proposal_submitted', 'closed', 'invited')).toEqual({
      ok: true,
      steps: ['close'],
    });
    // The closed request stays terminal for every grain.
    expect(planFastForward('closed', 'accepted', 'invited')).toEqual({
      ok: false,
      refusal: 'request_closed',
    });
    // `declined_track` is unconditional — the real action's transition guard is the authority.
    expect(planFastForward('proposal_submitted', 'declined_track', 'invited')).toEqual({
      ok: true,
      steps: ['decline_track'],
    });
  });
});

describe('F5 — the restated ladders still cover the live enums', () => {
  /**
   * The planner RESTATES both status vocabularies as local maps (it may not value-import
   * `@balo/db` — a client component imports it). A value appended to either pgEnum would
   * otherwise fall through to `off_spine` with nothing failing. These two sweeps are the pin:
   * they read the real enums and assert every rankable value is actually ranked.
   */
  it('every request status except draft/closed is ranked on the request spine', () => {
    const rankable = projectRequestStatusEnum.enumValues.filter(
      (status) => status !== 'draft' && status !== 'closed'
    );
    expect(rankable).toHaveLength(projectRequestStatusEnum.enumValues.length - 2);
    expect(rankable.length).toBeGreaterThan(0);
    for (const status of rankable) {
      const result = planFastForward(status, 'accepted');
      expect(result.ok || result.refusal !== 'off_spine', `${status} must be ranked`).toBe(true);
    }
  });

  it('every relationship status except declined is ranked on the track ladder', () => {
    const rankable = requestExpertRelationshipStatusEnum.enumValues.filter(
      (status) => status !== 'declined'
    );
    expect(rankable).toHaveLength(requestExpertRelationshipStatusEnum.enumValues.length - 1);
    expect(rankable.length).toBeGreaterThan(0);
    for (const status of rankable) {
      const result = planFastForward('requested', 'accepted', status);
      expect(result.ok || result.refusal !== 'off_spine', `${status} must be ranked`).toBe(true);
    }
    // …and the one deliberate omission is refused by NAME, not by falling through to off_spine.
    expect(planFastForward('requested', 'accepted', 'declined')).toEqual({
      ok: false,
      refusal: 'track_declined',
    });
  });
});

describe('reachableTargets', () => {
  it('at requested: every target except already-past ones is reachable', () => {
    const targets = reachableTargets('requested');
    expect(targets).toEqual([
      'experts_invited',
      'eoi_submitted',
      'proposal_requested',
      'proposal_submitted',
      'accepted',
      'closed',
      'declined_track',
    ]);
    expect(targets.length).toBeGreaterThan(0);
  });

  it('at accepted: only closed-refusing / declinable / terminal survive as INELIGIBLE, so the spine is empty and closed is excluded', () => {
    const targets = reachableTargets('accepted');
    // Every spine target is already_at_or_past; `closed` is close_refused_at_stage.
    // Only `declined_track` (unconditional) remains reachable.
    expect(targets).toEqual(['declined_track']);
    expect(targets).toHaveLength(1);
  });

  it('at closed: nothing is reachable (non-vacuity: empty, not merely falsy)', () => {
    const targets = reachableTargets('closed');
    expect(targets).toEqual([]);
    expect(targets).toHaveLength(0);
  });

  it('F1(b) — at eoi_submitted, experts_invited is offered again (a second track is invitable)', () => {
    const targets = reachableTargets('eoi_submitted');
    expect(targets).toContain('experts_invited');
    expect(targets).toEqual([
      'experts_invited',
      'proposal_requested',
      'proposal_submitted',
      'accepted',
      'closed',
      'declined_track',
    ]);
    expect(targets).toHaveLength(6);
  });

  it('F1 — with a LAGGING track selected, the target list is the track’s, not the rollup’s', () => {
    const rollupTargets = reachableTargets('proposal_submitted');
    const trackTargets = reachableTargets('proposal_submitted', true, 'invited');
    expect(rollupTargets).toEqual(['accepted', 'closed', 'declined_track']);
    expect(trackTargets).toEqual([
      'eoi_submitted',
      'proposal_requested',
      'proposal_submitted',
      'accepted',
      'closed',
      'declined_track',
    ]);
    expect(trackTargets.length).toBeGreaterThan(rollupTargets.length);
  });

  it('F1 — a declined track leaves only the request-grain targets', () => {
    const targets = reachableTargets('proposal_submitted', true, 'declined');
    expect(targets).toEqual(['closed', 'declined_track']);
    expect(targets).toHaveLength(2);
  });

  it('at draft: only closed / declined_track are reachable (spine is off_spine)', () => {
    const targets = reachableTargets('draft');
    expect(targets).toEqual(['closed', 'declined_track']);
    expect(targets).toHaveLength(2);
  });

  describe('U6 — hasTracks excludes declined_track with zero tracks', () => {
    it('defaults hasTracks to true, so every existing single-arg call site is unaffected', () => {
      expect(reachableTargets('draft')).toEqual(reachableTargets('draft', true));
      expect(reachableTargets('requested')).toEqual(reachableTargets('requested', true));
    });

    it('excludes declined_track when hasTracks is false, everywhere it would otherwise appear', () => {
      const statuses = ['draft', 'requested', 'exploratory_meeting_requested', 'accepted'];
      const withoutTracks = statuses.map((status) => reachableTargets(status, false));
      expect(withoutTracks).toHaveLength(statuses.length);
      for (const targets of withoutTracks) {
        expect(targets).not.toContain('declined_track');
      }
    });

    it('leaves every other target unaffected by hasTracks (non-vacuity: real difference only on declined_track)', () => {
      const withTracks = reachableTargets('requested', true);
      const withoutTracks = reachableTargets('requested', false);
      expect(withTracks).toContain('declined_track');
      expect(withoutTracks).not.toContain('declined_track');
      expect(withoutTracks).toEqual(withTracks.filter((target) => target !== 'declined_track'));
      expect(withoutTracks.length).toBe(withTracks.length - 1);
    });

    it('at closed, hasTracks makes no difference — every target already refuses request_closed', () => {
      expect(reachableTargets('closed', false)).toEqual([]);
      expect(reachableTargets('closed', true)).toEqual([]);
    });
  });
});

describe('refusalCopy', () => {
  const ALL_REFUSALS: readonly PlanRefusal[] = [
    'request_closed',
    'already_at_or_past',
    'off_spine',
    'close_refused_at_stage',
    'track_declined',
  ];

  it('returns non-empty, distinct copy for every PlanRefusal (non-vacuity + length)', () => {
    const rendered = ALL_REFUSALS.map((refusal) => refusalCopy(refusal));
    expect(rendered).toHaveLength(ALL_REFUSALS.length);
    for (const copy of rendered) {
      expect(copy.length).toBeGreaterThan(0);
    }
    expect(new Set(rendered).size).toBe(ALL_REFUSALS.length);
  });

  it('copy is gender-neutral (no gendered pronoun)', () => {
    const rendered = ALL_REFUSALS.map((refusal) => refusalCopy(refusal)).join(' ');
    expect(rendered.toLowerCase()).not.toMatch(/\b(he|she|him|her|his|hers)\b/);
  });
});
