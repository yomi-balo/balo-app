import { describe, it, expect } from 'vitest';
import {
  DASHBOARD_EVENTS,
  DASHBOARD_UP_NEXT_MEETING_TYPES,
  DASHBOARD_UP_NEXT_TARGETS,
  DASHBOARD_UP_NEXT_ROW_STATES,
  DASHBOARD_YOUR_MOVE_CARD_KINDS,
  DASHBOARD_YOUR_MOVE_CHIPS,
  DASHBOARD_YOUR_MOVE_TARGETS,
  DASHBOARD_TRACK_STAGES,
  DASHBOARD_TRACK_TURNS,
  type DashboardEventMap,
} from './dashboard';

describe('DASHBOARD_EVENTS (BAL-566 / BAL-600, client)', () => {
  it('exposes exactly the dashboard events, sorted', () => {
    expect(Object.keys(DASHBOARD_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'TRACK_CLICKED',
      'TRACK_TERM_OPENED',
      'UP_NEXT_CLICKED',
      'UP_NEXT_VIEWED',
      'YOUR_MOVE_CLICKED',
      'YOUR_MOVE_FILTERED',
      'YOUR_MOVE_VIEWED',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(DASHBOARD_EVENTS.UP_NEXT_VIEWED).toBe('dashboard_up_next_viewed');
    expect(DASHBOARD_EVENTS.UP_NEXT_CLICKED).toBe('dashboard_up_next_clicked');
    expect(DASHBOARD_EVENTS.YOUR_MOVE_VIEWED).toBe('dashboard_your_move_viewed');
    expect(DASHBOARD_EVENTS.YOUR_MOVE_CLICKED).toBe('dashboard_your_move_clicked');
    expect(DASHBOARD_EVENTS.YOUR_MOVE_FILTERED).toBe('dashboard_your_move_filtered');
    expect(DASHBOARD_EVENTS.TRACK_CLICKED).toBe('dashboard_track_clicked');
    expect(DASHBOARD_EVENTS.TRACK_TERM_OPENED).toBe('dashboard_track_term_opened');
  });

  it('every value carries the dashboard_ prefix and a snake_case shape', () => {
    for (const value of Object.values(DASHBOARD_EVENTS)) {
      expect(value).toMatch(/^dashboard_[a-z]+(_[a-z]+)*$/);
    }
  });
});

describe('DASHBOARD_UP_NEXT_MEETING_TYPES', () => {
  it('is exactly the four listed context types, in display-tile order', () => {
    expect(DASHBOARD_UP_NEXT_MEETING_TYPES).toEqual([
      'case',
      'project_kickoff',
      'project_discovery',
      'request_interaction',
    ]);
  });
});

describe('DASHBOARD_UP_NEXT_TARGETS', () => {
  it('is exactly the six click targets', () => {
    expect(DASHBOARD_UP_NEXT_TARGETS).toEqual([
      'row',
      'join',
      'cases',
      'projects',
      'calendar',
      'find_expert',
    ]);
  });
});

describe('DASHBOARD_UP_NEXT_ROW_STATES', () => {
  it('is exactly the three row timing states', () => {
    expect(DASHBOARD_UP_NEXT_ROW_STATES).toEqual(['upcoming', 'starting_soon', 'happening_now']);
  });
});

describe('DASHBOARD_YOUR_MOVE_CARD_KINDS', () => {
  it('is exactly the seventeen card kinds', () => {
    expect(DASHBOARD_YOUR_MOVE_CARD_KINDS).toEqual([
      'calendar_reconnect',
      'invitation',
      'eoi_followup',
      'proposal_requested',
      'changes_requested',
      'kickoff_terms',
      'delivery_changes',
      'action_items',
      'messages',
      'receivable',
      'reschedule',
      'completion',
      'kickoff_billing',
      'exploratory_call',
      'eoi_reply',
      'proposal_review',
      'join_requests',
    ]);
  });
});

describe('DASHBOARD_YOUR_MOVE_CHIPS', () => {
  it('is exactly the fifteen filter chips', () => {
    expect(DASHBOARD_YOUR_MOVE_CHIPS).toEqual([
      'all',
      'calendar',
      'invitations',
      'interest',
      'proposals',
      'kickoff',
      'delivery',
      'action_items',
      'messages',
      'billing',
      'new_times',
      'work_to_review',
      'calls',
      'replies',
      'team',
    ]);
  });
});

describe('DASHBOARD_YOUR_MOVE_TARGETS', () => {
  it('is exactly the two click targets', () => {
    expect(DASHBOARD_YOUR_MOVE_TARGETS).toEqual(['card', 'action']);
  });
});

describe('track vocabularies', () => {
  it('pins the stage keys and turns', () => {
    expect(DASHBOARD_TRACK_STAGES).toEqual([
      'invited',
      'eoi',
      'matching',
      'interest',
      'proposal',
      'kickoff',
      'delivery',
    ]);
    expect(DASHBOARD_TRACK_TURNS).toEqual(['your_move', 'in_progress', 'waiting']);
  });

  it('track clicked carries workspace_type, stage and turn and no ids', () => {
    const clicked: DashboardEventMap[typeof DASHBOARD_EVENTS.TRACK_CLICKED] = {
      workspace_type: 'expert',
      stage: 'proposal',
      turn: 'your_move',
    };
    expect(Object.keys(clicked).sort((a, b) => a.localeCompare(b))).toEqual([
      'stage',
      'turn',
      'workspace_type',
    ]);
  });
});

describe('track term opened', () => {
  it('carries workspace_type, target and key and no ids', () => {
    const opened: DashboardEventMap[typeof DASHBOARD_EVENTS.TRACK_TERM_OPENED] = {
      workspace_type: 'company',
      target: 'stage',
      key: 'matching',
      via: 'hover',
    };
    expect(Object.keys(opened).sort((a, b) => a.localeCompare(b))).toEqual([
      'key',
      'target',
      'via',
      'workspace_type',
    ]);
  });
});

describe('Your move payloads carry workspace_type', () => {
  it('viewed, clicked and filtered all accept both workspace types', () => {
    const viewed: DashboardEventMap[typeof DASHBOARD_EVENTS.YOUR_MOVE_VIEWED] = {
      workspace_type: 'company',
      card_count: 1,
      card_kinds: ['receivable'],
    };
    const clicked: DashboardEventMap[typeof DASHBOARD_EVENTS.YOUR_MOVE_CLICKED] = {
      workspace_type: 'expert',
      target: 'card',
      card_kind: 'messages',
      position: 1,
    };
    const filtered: DashboardEventMap[typeof DASHBOARD_EVENTS.YOUR_MOVE_FILTERED] = {
      workspace_type: 'company',
      chip: 'team',
      card_count: 2,
    };
    expect([viewed.workspace_type, clicked.workspace_type, filtered.workspace_type]).toEqual([
      'company',
      'expert',
      'company',
    ]);
  });
});
