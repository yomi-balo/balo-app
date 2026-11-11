/**
 * BAL-636 — the meeting id of the recap or end page the viewer is ON, or `null` for any other
 * path. Matches exactly `/meetings/{id}` and `/meetings/{id}/end`. The top-nav call pill hides the
 * call whose own recap/end page is open — the call is over there, so a Join to it is noise.
 *
 * ⚠ NO REGEX. A segment walk is linear and carries no S5852 exposure. `/meetings/{id}/call` is
 * deliberately NOT matched: that route has no TopNav (`isMeetingCallPath`).
 */
export function meetingIdOfRecapOrEndPath(pathname: string): string | null {
  // '' | 'meetings' | '{id}' [| 'end'] — a leading slash yields an empty first segment.
  const segments = pathname.split('?')[0]?.split('#')[0]?.split('/') ?? [];
  if (segments.length !== 3 && segments.length !== 4) return null;
  const [empty, meetings, meetingId, tail] = segments;
  if (empty !== '' || meetings !== 'meetings') return null;
  if (meetingId === undefined || meetingId.length === 0) return null;
  if (segments.length === 4 && tail !== 'end') return null;
  return meetingId;
}
