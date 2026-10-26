import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  PROJECT_EVENTS,
  PROJECT_SERVER_EVENTS,
  PROJECT_TRACK_PASS_SURFACES,
  type ProjectEventMap,
  type ProjectServerEventMap,
  type ProjectTrackPassSurface,
} from './project';

describe('PROJECT_EVENTS.BILLING_REMINDER_SENT (BAL-324)', () => {
  it('maps to the feature-prefixed snake_case event name', () => {
    expect(PROJECT_EVENTS.BILLING_REMINDER_SENT).toBe('project_billing_reminder_sent');
  });

  it('follows the {feature}_{noun}_{past_tense_verb} convention', () => {
    expect(PROJECT_EVENTS.BILLING_REMINDER_SENT).toMatch(/^project_[a-z]+(_[a-z]+)*$/);
  });
});

describe('PROJECT_EVENTS.REQUEST_OWNER_ASSIGNED / INTERNAL_NOTE_CREATED (BAL-541)', () => {
  it('maps to the feature-prefixed snake_case event names', () => {
    expect(PROJECT_EVENTS.REQUEST_OWNER_ASSIGNED).toBe('project_request_owner_assigned');
    expect(PROJECT_EVENTS.INTERNAL_NOTE_CREATED).toBe('project_internal_note_created');
  });

  it('follows the {feature}_{noun}_{past_tense_verb} convention', () => {
    expect(PROJECT_EVENTS.REQUEST_OWNER_ASSIGNED).toMatch(/^project_[a-z]+(_[a-z]+)*$/);
    expect(PROJECT_EVENTS.INTERNAL_NOTE_CREATED).toMatch(/^project_[a-z]+(_[a-z]+)*$/);
  });
});

describe('PROJECT_EVENTS AI brief path (BAL-254)', () => {
  it('maps to the feature-prefixed snake_case event names', () => {
    expect(PROJECT_EVENTS.PROJECT_AI_GENERATE_STARTED).toBe('project_ai_generate_started');
    expect(PROJECT_EVENTS.PROJECT_AI_GENERATE_SUCCEEDED).toBe('project_ai_generate_succeeded');
    expect(PROJECT_EVENTS.PROJECT_AI_GENERATE_FAILED).toBe('project_ai_generate_failed');
    expect(PROJECT_EVENTS.PROJECT_AI_REGENERATE_CLICKED).toBe('project_ai_regenerate_clicked');
    expect(PROJECT_EVENTS.PROJECT_AI_FIELDS_EDITED).toBe('project_ai_fields_edited');
  });

  it('follows the {feature}_{noun}_{past_tense_verb} convention', () => {
    expect(PROJECT_EVENTS.PROJECT_AI_GENERATE_STARTED).toMatch(/^project_[a-z]+(_[a-z]+)*$/);
    expect(PROJECT_EVENTS.PROJECT_AI_GENERATE_SUCCEEDED).toMatch(/^project_[a-z]+(_[a-z]+)*$/);
    expect(PROJECT_EVENTS.PROJECT_AI_GENERATE_FAILED).toMatch(/^project_[a-z]+(_[a-z]+)*$/);
    expect(PROJECT_EVENTS.PROJECT_AI_REGENERATE_CLICKED).toMatch(/^project_[a-z]+(_[a-z]+)*$/);
    expect(PROJECT_EVENTS.PROJECT_AI_FIELDS_EDITED).toMatch(/^project_[a-z]+(_[a-z]+)*$/);
  });
});

describe('PROJECT_EVENTS new-request notice (BAL-582)', () => {
  it('maps to the feature-prefixed snake_case event names', () => {
    expect(PROJECT_EVENTS.PROJECT_NEW_REQUEST_NOTICE_SHOWN).toBe(
      'project_new_request_notice_shown'
    );
    expect(PROJECT_EVENTS.PROJECT_NEW_REQUEST_UNDO_CLICKED).toBe(
      'project_new_request_undo_clicked'
    );
    expect(PROJECT_EVENTS.PROJECT_NEW_REQUEST_DISMISSED).toBe('project_new_request_dismissed');
  });

  it('follows the {feature}_{noun}_{past_tense_verb} convention', () => {
    expect(PROJECT_EVENTS.PROJECT_NEW_REQUEST_NOTICE_SHOWN).toMatch(/^project_[a-z]+(_[a-z]+)*$/);
    expect(PROJECT_EVENTS.PROJECT_NEW_REQUEST_UNDO_CLICKED).toMatch(/^project_[a-z]+(_[a-z]+)*$/);
    expect(PROJECT_EVENTS.PROJECT_NEW_REQUEST_DISMISSED).toMatch(/^project_[a-z]+(_[a-z]+)*$/);
  });
});

describe('PROJECT_EVENTS routing switch / expert unavailable (BAL-588)', () => {
  it('maps to the feature-prefixed snake_case event names', () => {
    expect(PROJECT_EVENTS.PROJECT_ROUTING_SWITCHED).toBe('project_routing_switched');
    expect(PROJECT_EVENTS.PROJECT_EXPERT_UNAVAILABLE_SHOWN).toBe(
      'project_expert_unavailable_shown'
    );
  });

  it('follows the {feature}_{noun}_{past_tense_verb} convention', () => {
    expect(PROJECT_EVENTS.PROJECT_ROUTING_SWITCHED).toMatch(/^project_[a-z]+(_[a-z]+)*$/);
    expect(PROJECT_EVENTS.PROJECT_EXPERT_UNAVAILABLE_SHOWN).toMatch(/^project_[a-z]+(_[a-z]+)*$/);
  });

  it('expert_unavailable_shown carries which surface raised the notice', () => {
    expectTypeOf<
      ProjectEventMap[typeof PROJECT_EVENTS.PROJECT_EXPERT_UNAVAILABLE_SHOWN]['trigger']
    >().toEqualTypeOf<'profile_data' | 'submit_rejected'>();
  });
});

describe('PROJECT_EVENTS review blocked', () => {
  it('maps to the feature-prefixed snake_case event name', () => {
    expect(PROJECT_EVENTS.PROJECT_REVIEW_BLOCKED).toBe('project_review_blocked');
    expect(PROJECT_EVENTS.PROJECT_REVIEW_BLOCKED).toMatch(/^project_[a-z]+(_[a-z]+)*$/);
  });

  it('carries which check blocked and which path produced the draft', () => {
    type Props = ProjectEventMap[typeof PROJECT_EVENTS.PROJECT_REVIEW_BLOCKED];
    expectTypeOf<Props['reason']>().toEqualTypeOf<
      'title' | 'description_too_short' | 'description_too_long' | 'budget_range'
    >();
    expectTypeOf<Props['method']>().toEqualTypeOf<'manual' | 'ai'>();
  });
});

describe('PROJECT_EVENTS proposal composer v2 (BAL-610)', () => {
  it('maps to the feature-prefixed snake_case event names', () => {
    expect(PROJECT_EVENTS.PROPOSAL_MILESTONE_PRICING_TOGGLED).toBe(
      'project_proposal_milestone_pricing_toggled'
    );
    expect(PROJECT_EVENTS.PROPOSAL_CHECKLIST_JUMPED).toBe('project_proposal_checklist_jumped');
    expect(PROJECT_EVENTS.PROPOSAL_PREVIEW_OPENED).toBe('project_proposal_preview_opened');
  });

  it('follows the {feature}_{noun}_{past_tense_verb} convention', () => {
    expect(PROJECT_EVENTS.PROPOSAL_MILESTONE_PRICING_TOGGLED).toMatch(/^project_[a-z]+(_[a-z]+)*$/);
    expect(PROJECT_EVENTS.PROPOSAL_CHECKLIST_JUMPED).toMatch(/^project_[a-z]+(_[a-z]+)*$/);
    expect(PROJECT_EVENTS.PROPOSAL_PREVIEW_OPENED).toMatch(/^project_[a-z]+(_[a-z]+)*$/);
  });

  it('types the jump source, toggle and preview properties', () => {
    expectTypeOf<
      ProjectEventMap[typeof PROJECT_EVENTS.PROPOSAL_CHECKLIST_JUMPED]['source']
    >().toEqualTypeOf<'rail' | 'cta' | 'mobile_bar' | 'shortcut'>();
    expectTypeOf<
      ProjectEventMap[typeof PROJECT_EVENTS.PROPOSAL_MILESTONE_PRICING_TOGGLED]['enabled']
    >().toEqualTypeOf<boolean>();
    expectTypeOf<
      ProjectEventMap[typeof PROJECT_EVENTS.PROPOSAL_PREVIEW_OPENED]['pricing_method']
    >().toEqualTypeOf<'fixed' | 'tm'>();
  });
});

describe('AI-drafted proposal events (BAL-611)', () => {
  it('maps to the feature-prefixed snake_case event names', () => {
    expect(PROJECT_EVENTS.PROPOSAL_DRAFT_CLEARED).toBe('project_proposal_draft_cleared');
    expect(PROJECT_EVENTS.PROPOSAL_DRAFT_DISCARDED).toBe('project_proposal_draft_discarded');
    expect(PROJECT_SERVER_EVENTS.PROPOSAL_DRAFT_GENERATED).toBe('project_proposal_draft_generated');
  });

  it('follows the {feature}_{noun}_{past_tense_verb} convention', () => {
    expect(PROJECT_EVENTS.PROPOSAL_DRAFT_CLEARED).toMatch(/^project_[a-z]+(_[a-z]+)*$/);
    expect(PROJECT_EVENTS.PROPOSAL_DRAFT_DISCARDED).toMatch(/^project_[a-z]+(_[a-z]+)*$/);
    expect(PROJECT_SERVER_EVENTS.PROPOSAL_DRAFT_GENERATED).toMatch(/^project_[a-z]+(_[a-z]+)*$/);
  });

  it('types the cleared section, the discard, and the generation outcome', () => {
    expectTypeOf<ProjectEventMap[typeof PROJECT_EVENTS.PROPOSAL_DRAFT_CLEARED]>().toEqualTypeOf<{
      section: 'overview' | 'milestones';
      relationship_id: string;
    }>();
    expectTypeOf<ProjectEventMap[typeof PROJECT_EVENTS.PROPOSAL_DRAFT_DISCARDED]>().toEqualTypeOf<{
      relationship_id: string;
    }>();
    expectTypeOf<
      ProjectServerEventMap[typeof PROJECT_SERVER_EVENTS.PROPOSAL_DRAFT_GENERATED]
    >().toEqualTypeOf<{
      relationship_id: string;
      status: 'succeeded' | 'failed';
      latency_ms: number;
      milestone_count: number;
      distinct_id: string;
    }>();
  });

  it('records whether a draft was generated for a submitted proposal', () => {
    expectTypeOf<
      ProjectServerEventMap[typeof PROJECT_SERVER_EVENTS.PROJECT_PROPOSAL_SUBMITTED]['ai_draft_generated']
    >().toEqualTypeOf<boolean>();
    expectTypeOf<
      ProjectServerEventMap[typeof PROJECT_SERVER_EVENTS.PROJECT_PROPOSAL_SUBMITTED]
    >().not.toHaveProperty('used_ai_draft');
  });
});

describe('PROJECT_SERVER_EVENTS', () => {
  it('has the request-access-denied, server-emitted proposal, admin-fee, PDF-download, and share events (BAL-276 / BAL-357 / BAL-358 / BAL-385 / BAL-386 / BAL-604)', () => {
    expect(Object.keys(PROJECT_SERVER_EVENTS)).toEqual([
      'REQUEST_ACCESS_DENIED',
      'PROJECT_PROPOSAL_SUBMITTED',
      'PROJECT_PROPOSAL_ACCEPTED',
      'ADMIN_PROJECT_FEE_OVERRIDDEN',
      'PROJECT_PROPOSAL_PDF_DOWNLOADED',
      'PROPOSAL_SHARE_CREATED',
      'PROPOSAL_SHARE_OPENED',
      'PROPOSAL_SHARE_REVOKED',
      'PROJECT_TRACK_PASSED',
      'PROPOSAL_DRAFT_GENERATED',
    ]);
  });

  it('uses the {feature}_{noun}_{past_tense_verb} snake_case convention', () => {
    // Values carry a feature prefix (`project_` for participant events, `admin_` for
    // the admin-audience fee override) — assert snake_case shape across all.
    for (const value of Object.values(PROJECT_SERVER_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  it('maps PROJECT_TRACK_PASSED to project_track_passed (BAL-604)', () => {
    expect(PROJECT_SERVER_EVENTS.PROJECT_TRACK_PASSED).toBe('project_track_passed');
  });

  it('records which entry point the expert passed from (BAL-604)', () => {
    expect(PROJECT_TRACK_PASS_SURFACES).toEqual(['nudge', 'control']);
    expectTypeOf<
      ProjectServerEventMap[typeof PROJECT_SERVER_EVENTS.PROJECT_TRACK_PASSED]['surface']
    >().toEqualTypeOf<ProjectTrackPassSurface>();
  });

  it('maps the constants to their exact event names', () => {
    expect(PROJECT_SERVER_EVENTS.REQUEST_ACCESS_DENIED).toBe('project_request_access_denied');
    // BAL-357: kept identical to the former client-event values for analytics continuity.
    expect(PROJECT_SERVER_EVENTS.PROJECT_PROPOSAL_SUBMITTED).toBe('project_proposal_submitted');
    expect(PROJECT_SERVER_EVENTS.PROJECT_PROPOSAL_ACCEPTED).toBe('project_proposal_accepted');
    // BAL-358: the admin per-project fee override (admin-audience feature prefix).
    expect(PROJECT_SERVER_EVENTS.ADMIN_PROJECT_FEE_OVERRIDDEN).toBe('admin_project_fee_overridden');
    // BAL-385: server-side client-facing proposal PDF download.
    expect(PROJECT_SERVER_EVENTS.PROJECT_PROPOSAL_PDF_DOWNLOADED).toBe(
      'project_proposal_pdf_downloaded'
    );
    // BAL-386: server-side proposal share create/open/revoke.
    expect(PROJECT_SERVER_EVENTS.PROPOSAL_SHARE_CREATED).toBe('project_proposal_share_created');
    expect(PROJECT_SERVER_EVENTS.PROPOSAL_SHARE_OPENED).toBe('project_proposal_share_opened');
    expect(PROJECT_SERVER_EVENTS.PROPOSAL_SHARE_REVOKED).toBe('project_proposal_share_revoked');
  });
});
