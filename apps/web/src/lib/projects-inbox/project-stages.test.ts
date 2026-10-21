import { describe, it, expect } from 'vitest';
import { DASHBOARD_TRACK_TURNS } from '@balo/analytics/events';
import type { StageKey } from './portfolio-row';
import {
  CLOSED_STAGE_LABEL,
  PARTICIPANT_STAGES,
  TURN_EXPLANATIONS,
  participantStageFor,
  participantStageLabel,
  stageLensOfWorkspace,
} from './project-stages';

const ALL_STAGE_KEYS: readonly StageKey[] = [
  'requested',
  'exploratory',
  'invited',
  'eoi',
  'prop_req',
  'prop_in',
  'accepted',
  'kicked',
  'closed',
];

const EXPECTED = {
  expert: [
    [
      'invited',
      'Invited',
      'Balo invited you to this project. Read the brief and send your interest if it’s a fit.',
    ],
    [
      'eoi',
      'Interest sent',
      'You’ve told the client you’re interested. Next, you talk and they may ask for a proposal.',
    ],
    [
      'proposal',
      'Proposal',
      'The client asked you for a proposal, or is reviewing the one you sent.',
    ],
    [
      'kickoff',
      'Kickoff',
      'Your proposal was accepted. The project starts once you, the client and Balo have each confirmed.',
    ],
    [
      'delivery',
      'Delivery',
      'The project is underway. You deliver the milestones and the client reviews the work.',
    ],
  ],
  client: [
    [
      'matching',
      'Matching',
      'Balo is finding experts for your request, or wants a quick call with you first.',
    ],
    [
      'interest',
      'Interest',
      'Experts are interested. Talk with them and ask the ones you like for a proposal.',
    ],
    [
      'proposal',
      'Proposals',
      'Experts are writing proposals, or have sent them for you to review.',
    ],
    [
      'kickoff',
      'Kickoff',
      'You’ve accepted a proposal. The project starts once you, the expert and Balo have each confirmed.',
    ],
    [
      'delivery',
      'Delivery',
      'The project is underway. You review the work when the expert marks it complete.',
    ],
  ],
} as const;

describe('PARTICIPANT_STAGES', () => {
  it.each(['expert', 'client'] as const)('%s lens carries the five stages verbatim', (lens) => {
    expect(PARTICIPANT_STAGES[lens].map((s) => [s.key, s.label, s.explanation])).toEqual(
      EXPECTED[lens]
    );
  });
});

describe('TURN_EXPLANATIONS', () => {
  it.each(['expert', 'client'] as const)('%s lens has a sentence for every turn', (lens) => {
    for (const turn of DASHBOARD_TRACK_TURNS) {
      expect(TURN_EXPLANATIONS[lens][turn].length).toBeGreaterThan(0);
    }
  });

  it('names the other party in the waiting sentence per lens', () => {
    expect(TURN_EXPLANATIONS.expert.waiting).toBe(
      'You’ve done your part. The client, or Balo, is up next.'
    );
    expect(TURN_EXPLANATIONS.client.waiting).toBe(
      'You’ve done your part. The expert, or Balo, is up next.'
    );
    expect(TURN_EXPLANATIONS.client.your_move).toBe('Something here is waiting on you.');
    expect(TURN_EXPLANATIONS.expert.in_progress).toBe('Work is underway and nobody is blocked.');
  });
});

describe('stageLensOfWorkspace', () => {
  it('maps company to client and expert to expert', () => {
    expect(stageLensOfWorkspace('company')).toBe('client');
    expect(stageLensOfWorkspace('expert')).toBe('expert');
  });
});

describe('participantStageFor / participantStageLabel', () => {
  it.each(['expert', 'client'] as const)('%s lens resolves every non-closed key', (lens) => {
    for (const key of ALL_STAGE_KEYS.filter((k) => k !== 'closed')) {
      const stage = participantStageFor(lens, key);
      expect(stage).not.toBeNull();
      expect(PARTICIPANT_STAGES[lens]).toContain(stage);
    }
    expect(participantStageFor(lens, 'closed')).toBeNull();
    expect(participantStageLabel(lens, 'closed')).toBe(CLOSED_STAGE_LABEL);
  });

  it('labels an invited expert row "Invited" and client pre-interest keys "Matching"', () => {
    expect(participantStageLabel('expert', 'invited')).toBe('Invited');
    expect(participantStageLabel('expert', 'requested')).toBe('Invited');
    for (const key of ['requested', 'exploratory', 'invited'] as const) {
      expect(participantStageLabel('client', key)).toBe('Matching');
    }
  });

  it('uses the lens vocabulary for later stages', () => {
    expect(participantStageLabel('client', 'eoi')).toBe('Interest');
    expect(participantStageLabel('expert', 'eoi')).toBe('Interest sent');
    expect(participantStageLabel('client', 'prop_in')).toBe('Proposals');
    expect(participantStageLabel('expert', 'prop_req')).toBe('Proposal');
    expect(participantStageLabel('client', 'accepted')).toBe('Kickoff');
    expect(participantStageLabel('expert', 'kicked')).toBe('Delivery');
  });
});
