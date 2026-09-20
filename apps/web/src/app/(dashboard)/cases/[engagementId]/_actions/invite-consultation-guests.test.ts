import { beforeEach, expect, it, vi } from 'vitest';

const { mockPerformGuestInvite } = vi.hoisted(() => ({
  mockPerformGuestInvite: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/meetings/invite-guests-flow', () => ({
  performGuestInvite: mockPerformGuestInvite,
}));

import { inviteConsultationGuestsAction } from './invite-consultation-guests';

/**
 * BAL-573 — the case surface's thin wrapper over the shared guest-invite flow. Its one job is
 * supplying `entryPoint: 'case_surface'`, which `performGuestInvite` requires and never
 * defaults.
 */

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const EMAIL = 'dana@northwind.example';

beforeEach(() => {
  vi.clearAllMocks();
});

it('forwards entryPoint: case_surface and returns the flow result unchanged', async () => {
  const flowResult = {
    success: true as const,
    invitedCount: 1,
    participantCount: 3,
    participantCap: 10,
  };
  mockPerformGuestInvite.mockResolvedValue(flowResult);

  const result = await inviteConsultationGuestsAction({ meetingId: MEETING_ID, emails: [EMAIL] });

  expect(mockPerformGuestInvite).toHaveBeenCalledWith({
    meetingId: MEETING_ID,
    emails: [EMAIL],
    entryPoint: 'case_surface',
  });
  expect(result).toBe(flowResult);
});

it('forwards a failure result unchanged too', async () => {
  const flowResult = { success: false as const, error: 'Nope.', outcome: 'failed' as const };
  mockPerformGuestInvite.mockResolvedValue(flowResult);

  const result = await inviteConsultationGuestsAction({ meetingId: MEETING_ID, emails: [EMAIL] });

  expect(result).toBe(flowResult);
});

/**
 * A Server Action's arguments are client-deserialized, so a caller CAN put its own
 * `entryPoint` inside the input object. `{ ...input, entryPoint: 'case_surface' }` wins only
 * because the literal follows the spread; a reorder to `{ entryPoint, ...input }` would
 * silently make attribution client-controlled. Cast through `unknown` — the typed signature
 * has no `entryPoint` key to assign one legitimately.
 */
it('⚠ a rogue `entryPoint` inside the input is NOT what gets forwarded — the literal wins', async () => {
  const flowResult = {
    success: true as const,
    invitedCount: 1,
    participantCount: 3,
    participantCap: 10,
  };
  mockPerformGuestInvite.mockResolvedValue(flowResult);

  await inviteConsultationGuestsAction({
    meetingId: MEETING_ID,
    emails: [EMAIL],
    entryPoint: 'in_call',
  } as unknown as { meetingId: string; emails: readonly string[] });

  expect(mockPerformGuestInvite).toHaveBeenCalledWith({
    meetingId: MEETING_ID,
    emails: [EMAIL],
    entryPoint: 'case_surface',
  });
});
