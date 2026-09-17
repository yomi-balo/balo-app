import { describe, it, expect } from 'vitest';
import { hrefForMeeting, type MeetingHrefSubject } from './href-for-meeting';
import type { MeetingContextTypeWithHolder } from '@balo/shared/meetings';

const CONTEXT_ID = 'ctx-1';
const PROJECT_REQUEST_ID = 'req-1';

function subject(overrides: Partial<MeetingHrefSubject> = {}): MeetingHrefSubject {
  return {
    owningRowFound: true,
    contextType: 'case',
    contextId: CONTEXT_ID,
    projectRequestId: null,
    ...overrides,
  };
}

describe('hrefForMeeting (BAL-566 D6)', () => {
  const EXPECTED: Record<MeetingContextTypeWithHolder, string | null> = {
    case: `/cases/${CONTEXT_ID}`,
    project_kickoff: `/engagements/${CONTEXT_ID}`,
    project_discovery: `/projects/${PROJECT_REQUEST_ID}`,
    request_interaction: `/projects/${PROJECT_REQUEST_ID}`,
    package_session: null,
    retainer_checkin: null,
  };

  for (const [contextType, expected] of Object.entries(EXPECTED) as [
    MeetingContextTypeWithHolder,
    string | null,
  ][]) {
    it(`resolves ${contextType} when owningRowFound`, () => {
      expect(hrefForMeeting(subject({ contextType, projectRequestId: PROJECT_REQUEST_ID }))).toBe(
        expected
      );
    });

    it(`returns null for ${contextType} when owningRowFound is false`, () => {
      expect(
        hrefForMeeting(
          subject({
            contextType,
            owningRowFound: false,
            contextId: null,
            projectRequestId: null,
          })
        )
      ).toBeNull();
    });
  }

  it('request_interaction uses projectRequestId, never the raw contextId', () => {
    const href = hrefForMeeting(
      subject({
        contextType: 'request_interaction',
        contextId: 'relationship-id',
        projectRequestId: PROJECT_REQUEST_ID,
      })
    );
    expect(href).toBe(`/projects/${PROJECT_REQUEST_ID}`);
    expect(href).not.toContain('relationship-id');
  });

  it('request-grain with a null projectRequestId returns null even though owningRowFound is true', () => {
    expect(
      hrefForMeeting(subject({ contextType: 'project_discovery', projectRequestId: null }))
    ).toBeNull();
  });

  it('a contextId of null with owningRowFound true still returns null (defensive)', () => {
    expect(hrefForMeeting(subject({ contextId: null }))).toBeNull();
  });
});
