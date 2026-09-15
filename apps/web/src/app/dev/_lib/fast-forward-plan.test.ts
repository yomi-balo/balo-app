import { describe, expect, it } from 'vitest';
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
      expect(planFastForward('experts_invited', 'experts_invited')).toEqual({
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
