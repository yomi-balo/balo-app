import { describe, it, expect } from 'vitest';
import { MEETING_TYPE_LABEL, meetingTypeLabel } from './meeting-type-label';
import type { MeetingContextTypeWithHolder } from '@balo/shared/meetings';

describe('meetingTypeLabel (BAL-566 D5)', () => {
  it('labels the four Up next context types', () => {
    expect(meetingTypeLabel('case')).toBe('Consultation');
    expect(meetingTypeLabel('project_kickoff')).toBe('Project kickoff');
    expect(meetingTypeLabel('project_discovery')).toBe('Discovery call');
    expect(meetingTypeLabel('request_interaction')).toBe('Intro call');
  });

  it('labels the two non-Up-next context types too (recap consumers)', () => {
    expect(meetingTypeLabel('package_session')).toBe('Package session');
    expect(meetingTypeLabel('retainer_checkin')).toBe('Retainer check-in');
  });

  it('the map is total over every MeetingContextTypeWithHolder label, with no default', () => {
    const ALL: readonly MeetingContextTypeWithHolder[] = [
      'case',
      'project_discovery',
      'project_kickoff',
      'package_session',
      'retainer_checkin',
      'request_interaction',
    ];
    const labelled = ALL.map((type) => MEETING_TYPE_LABEL[type]);
    expect(labelled.every((label) => typeof label === 'string' && label.length > 0)).toBe(true);
    expect(labelled).toHaveLength(6);
    expect(Object.keys(MEETING_TYPE_LABEL).sort((a, b) => a.localeCompare(b))).toEqual(
      [...ALL].sort((a, b) => a.localeCompare(b))
    );
  });
});
