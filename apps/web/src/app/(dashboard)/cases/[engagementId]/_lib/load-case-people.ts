import 'server-only';

import {
  meetingGuestsRepository,
  meetingPresenceRepository,
  partyMembershipsRepository,
  usersRepository,
  type MeetingGuestInviteChannel,
  type MeetingParticipantParty,
} from '@balo/db';
import { personDisplayName } from '@balo/shared/parties';
import { errorMessage, log } from '@/lib/logging';
import type { CasePeopleGroupView, CasePersonView } from '@/lib/cases/case-view-types';

/** The label of the group holding guests who joined through a shared link. */
export const JOINED_BY_LINK_LABEL = 'Joined by link';

export interface LoadCasePeopleInput {
  lens: 'client' | 'expert';
  viewerUserId: string;
  deliveringExpertUserId: string | null;
  deliveringAgencyId: string | null;
  clientPartyLabel: string;
  expertPartyLabel: string;
  /** Every consultation on the case; attendance is read across all of them. */
  meetingIds: readonly string[];
  /** The consultations that can still hold a seat; invited guests are read from these. */
  upcomingMeetingIds: readonly string[];
}

type Side = 'client' | 'expert';
type GroupSide = Side | 'link';

interface DraftPerson {
  isViewer: boolean;
  isDeliveringExpert: boolean;
  name: string;
}

interface AttendeeRow {
  userId: string;
  party: MeetingParticipantParty;
}

interface GuestRow {
  name: string | null;
  party: Side;
  inviteChannel: MeetingGuestInviteChannel;
  matchedUserId: string | null;
}

/**
 * BAL-633 — everyone on a case, grouped by side, for the People card.
 *
 * Column-projected reads only, in at most four queries across two parallel waves whatever the
 * number of consultations. No tenancy of its own: the meeting ids come from
 * `listMeetingsForContext`, which the loader only calls after its tenancy steps.
 *
 * Who is listed: the viewer (as "You"), the delivering expert (unless they are an independent
 * expert, whose name is already the group label), every authenticated attendee of a past or live
 * consultation on their attended side, live members of the delivering agency who sat in as
 * observers (any role), and guests who attended or hold a seat on an upcoming consultation.
 * Nobody is read from the audit trail, so there is no "booker". A Balo staffer observing is never
 * listed. No email address is read or returned (ADR-1044): a guest is a name or part of a count.
 *
 * A person is placed once, on the first side that claims them. A failed read returns the
 * fallback groups (the viewer, plus the counterparty label alone) and logs, so the page never
 * fails on this card.
 */
export async function loadCasePeople(input: LoadCasePeopleInput): Promise<CasePeopleGroupView[]> {
  try {
    return await assemble(input);
  } catch (error) {
    log.error('Case surface people lookup failed', {
      meetingCount: input.meetingIds.length,
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return fallbackGroups(input);
  }
}

function viewerSide(lens: LoadCasePeopleInput['lens']): Side {
  return lens === 'client' ? 'client' : 'expert';
}

function partyLabels(input: LoadCasePeopleInput): Record<Side, string> {
  return { client: input.clientPartyLabel, expert: input.expertPartyLabel };
}

function fallbackGroups(input: LoadCasePeopleInput): CasePeopleGroupView[] {
  const own = viewerSide(input.lens);
  const other: Side = own === 'client' ? 'expert' : 'client';
  const labels = partyLabels(input);
  return [
    {
      side: own,
      label: labels[own],
      people: [{ key: 'p0', name: 'You', isViewer: true }],
      unnamedGuestCount: 0,
    },
    { side: other, label: labels[other], people: [], unnamedGuestCount: 0 },
  ];
}

/** The first side to claim a user wins: viewer, delivering expert, then attendance by party. */
function placeKnownUsers(
  input: LoadCasePeopleInput,
  attendees: readonly AttendeeRow[]
): Map<string, Side> {
  const sideByUser = new Map<string, Side>();
  const place = (userId: string, side: Side): void => {
    if (!sideByUser.has(userId)) sideByUser.set(userId, side);
  };
  place(input.viewerUserId, viewerSide(input.lens));
  if (input.deliveringExpertUserId !== null) place(input.deliveringExpertUserId, 'expert');
  for (const row of attendees) {
    if (row.party === 'expert') place(row.userId, 'expert');
    if (row.party === 'client') place(row.userId, 'client');
  }
  return sideByUser;
}

function unplacedObserverIds(
  attendees: readonly AttendeeRow[],
  sideByUser: ReadonlyMap<string, Side>
): string[] {
  return attendees
    .filter((row) => row.party === 'observer' && !sideByUser.has(row.userId))
    .map((row) => row.userId);
}

async function readNamesAndAgencyMembers(
  input: LoadCasePeopleInput,
  userIds: ReadonlySet<string>,
  observerIds: readonly string[]
): Promise<{ nameById: Map<string, string>; agencyMembers: Set<string> }> {
  const [nameRows, agencyMemberIds] = await Promise.all([
    userIds.size === 0 ? Promise.resolve([]) : usersRepository.findNamesByIds([...userIds]),
    observerIds.length > 0 && input.deliveringAgencyId !== null
      ? partyMembershipsRepository.listMemberUserIds('agency', input.deliveringAgencyId)
      : Promise.resolve<string[]>([]),
  ]);
  const nameById = new Map<string, string>();
  for (const row of nameRows) {
    const name = personDisplayName(row.firstName, row.lastName, '');
    if (name.length > 0) nameById.set(row.id, name);
  }
  return { nameById, agencyMembers: new Set(agencyMemberIds) };
}

/**
 * The placed users who get a row. A user with no name on file is omitted rather than shown under
 * a fallback. An independent expert (no delivering agency) is the group label itself, so is only
 * a row when they are the viewer.
 */
function draftMembers(
  input: LoadCasePeopleInput,
  sideByUser: ReadonlyMap<string, Side>,
  nameById: ReadonlyMap<string, string>
): Record<Side, DraftPerson[]> {
  const drafts: Record<Side, DraftPerson[]> = { client: [], expert: [] };
  const independentExpert = input.deliveringAgencyId === null;
  for (const [userId, side] of sideByUser) {
    const isViewer = userId === input.viewerUserId;
    const isDeliveringExpert = userId === input.deliveringExpertUserId;
    if (isDeliveringExpert && independentExpert && !isViewer) continue;
    const name = isViewer ? 'You' : nameById.get(userId);
    if (name !== undefined) drafts[side].push({ isViewer, isDeliveringExpert, name });
  }
  return drafts;
}

/**
 * An email-channel guest is dropped only when the same person is placed on the guest's own side,
 * so a match on the other side is never visible. A link guest has no party, so a placed member on
 * either side drops it.
 */
function isAlreadyListed(
  row: GuestRow,
  guestSide: GroupSide,
  sideByUser: ReadonlyMap<string, Side>
): boolean {
  if (row.matchedUserId === null) return false;
  const placed = sideByUser.get(row.matchedUserId);
  if (placed === undefined) return false;
  return guestSide === 'link' || placed === guestSide;
}

function bucketGuests(
  rows: readonly GuestRow[],
  sideByUser: ReadonlyMap<string, Side>,
  drafts: Record<GroupSide, DraftPerson[]>
): Record<GroupSide, number> {
  const unnamed: Record<GroupSide, number> = { client: 0, expert: 0, link: 0 };
  for (const row of rows) {
    const side: GroupSide = row.inviteChannel === 'link' ? 'link' : row.party;
    if (isAlreadyListed(row, side, sideByUser)) continue;
    const name = row.name?.trim() ?? '';
    if (name.length === 0) {
      unnamed[side] += 1;
    } else {
      drafts[side].push({ isViewer: false, isDeliveringExpert: false, name });
    }
  }
  return unnamed;
}

function assembleGroups(
  input: LoadCasePeopleInput,
  drafts: Record<GroupSide, DraftPerson[]>,
  unnamed: Record<GroupSide, number>
): CasePeopleGroupView[] {
  const order: GroupSide[] =
    viewerSide(input.lens) === 'client'
      ? ['client', 'expert', 'link']
      : ['expert', 'client', 'link'];
  const labels: Record<GroupSide, string> = { ...partyLabels(input), link: JOINED_BY_LINK_LABEL };

  let nextKey = 0;
  const groups: CasePeopleGroupView[] = [];
  for (const side of order) {
    const people: CasePersonView[] = [...drafts[side]].sort(compareDrafts).map((member) => ({
      key: `p${nextKey++}`,
      name: member.name,
      isViewer: member.isViewer,
    }));
    const unnamedGuestCount = unnamed[side];
    if (side === 'link' && people.length === 0 && unnamedGuestCount === 0) continue;
    groups.push({ side, label: labels[side], people, unnamedGuestCount });
  }
  return groups;
}

async function assemble(input: LoadCasePeopleInput): Promise<CasePeopleGroupView[]> {
  const [attendees, guestRows] = await Promise.all([
    meetingPresenceRepository.listAuthenticatedAttendeesByMeetingIds(input.meetingIds),
    meetingGuestsRepository.listRosterNamesForMeetings({
      attendedMeetingIds: input.meetingIds,
      seatedMeetingIds: input.upcomingMeetingIds,
    }),
  ]);

  const sideByUser = placeKnownUsers(input, attendees);
  const observerIds = unplacedObserverIds(attendees, sideByUser);
  const toName = new Set<string>([...sideByUser.keys(), ...observerIds]);
  toName.delete(input.viewerUserId);

  const { nameById, agencyMembers } = await readNamesAndAgencyMembers(input, toName, observerIds);
  for (const id of observerIds) {
    if (agencyMembers.has(id)) sideByUser.set(id, 'expert');
  }

  const memberDrafts = draftMembers(input, sideByUser, nameById);
  const drafts: Record<GroupSide, DraftPerson[]> = { ...memberDrafts, link: [] };
  const unnamed = bucketGuests(guestRows, sideByUser, drafts);
  return assembleGroups(input, drafts, unnamed);
}

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, 'en', { sensitivity: 'base' });
}

function compareDrafts(a: DraftPerson, b: DraftPerson): number {
  if (a.isViewer !== b.isViewer) return a.isViewer ? -1 : 1;
  if (a.isDeliveringExpert !== b.isDeliveringExpert) return a.isDeliveringExpert ? -1 : 1;
  return compareNames(a.name, b.name);
}
