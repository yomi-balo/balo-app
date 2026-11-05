import 'server-only';

import {
  meetingGuestsRepository,
  meetingPresenceRepository,
  partyMembershipsRepository,
  usersRepository,
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

interface DraftPerson {
  userId: string | null;
  isViewer: boolean;
  isDeliveringExpert: boolean;
}

/**
 * BAL-633 — everyone on a case, grouped by side, for the People card.
 *
 * Column-projected reads only, in at most four queries across two parallel waves whatever the
 * number of consultations. No tenancy of its own: the meeting ids come from
 * `listMeetingsForContext`, which the loader only calls after its tenancy steps.
 *
 * Who is listed: the viewer (as "You"), the delivering expert, every authenticated attendee of a
 * past or live consultation on their attended side, agency owners/admins who sat in as observers,
 * and guests who attended or hold a seat on an upcoming consultation. Nobody is read from the
 * audit trail, so there is no "booker". A Balo staffer observing is never listed. No email
 * address is read or returned (ADR-1044): a guest is a name or part of a count.
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

function fallbackGroups(input: LoadCasePeopleInput): CasePeopleGroupView[] {
  const own = viewerSide(input.lens);
  const other: Side = own === 'client' ? 'expert' : 'client';
  const labels: Record<Side, string> = {
    client: input.clientPartyLabel,
    expert: input.expertPartyLabel,
  };
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

async function assemble(input: LoadCasePeopleInput): Promise<CasePeopleGroupView[]> {
  const [attendees, guestRows] = await Promise.all([
    meetingPresenceRepository.listAuthenticatedAttendeesByMeetingIds(input.meetingIds),
    meetingGuestsRepository.listRosterNamesForMeetings({
      attendedMeetingIds: input.meetingIds,
      seatedMeetingIds: input.upcomingMeetingIds,
    }),
  ]);

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

  const observerIds = attendees.filter((row) => row.party === 'observer').map((row) => row.userId);
  const candidateObserverIds = observerIds.filter((id) => !sideByUser.has(id));

  const namedIds = new Set<string>([...sideByUser.keys(), ...candidateObserverIds]);
  namedIds.delete(input.viewerUserId);

  const [nameRows, agencyMemberIds] = await Promise.all([
    namedIds.size === 0 ? Promise.resolve([]) : usersRepository.findNamesByIds([...namedIds]),
    candidateObserverIds.length > 0 && input.deliveringAgencyId !== null
      ? partyMembershipsRepository.listMemberUserIds('agency', input.deliveringAgencyId)
      : Promise.resolve<string[]>([]),
  ]);

  const agencyMembers = new Set(agencyMemberIds);
  for (const id of candidateObserverIds) {
    if (agencyMembers.has(id)) place(id, 'expert');
  }

  const nameById = new Map<string, string>();
  for (const row of nameRows) {
    const name = personDisplayName(row.firstName, row.lastName, '');
    if (name.length > 0) nameById.set(row.id, name);
  }

  const expertLabelKey = input.expertPartyLabel.trim().toLowerCase();
  const drafts: Record<Side, Array<DraftPerson & { name: string }>> = { client: [], expert: [] };
  for (const [userId, side] of sideByUser) {
    const isViewer = userId === input.viewerUserId;
    const isDeliveringExpert = userId === input.deliveringExpertUserId;
    const name = isViewer ? 'You' : nameById.get(userId);
    if (name === undefined) continue;
    if (isDeliveringExpert && !isViewer && name.trim().toLowerCase() === expertLabelKey) continue;
    drafts[side].push({ userId, isViewer, isDeliveringExpert, name });
  }

  /**
   * An email-channel guest is dropped only when the same person is placed on the guest's own side,
   * so a match on the other side is never visible. A link guest has no party, so a placed member
   * on either side drops it.
   */
  const isPlacedMember = (
    userId: string | null,
    guestSide: 'client' | 'expert' | 'link'
  ): boolean => {
    if (userId === null) return false;
    const placed = sideByUser.get(userId);
    if (placed === undefined) return false;
    return guestSide === 'link' || placed === guestSide;
  };
  const linkDrafts: Array<DraftPerson & { name: string }> = [];
  const unnamed: Record<'client' | 'expert' | 'link', number> = { client: 0, expert: 0, link: 0 };
  for (const row of guestRows) {
    const side = row.inviteChannel === 'link' ? 'link' : row.party;
    if (isPlacedMember(row.userId, side) || isPlacedMember(row.convertedToUserId, side)) continue;
    const name = row.name?.trim() ?? '';
    if (name.length === 0) {
      unnamed[side] += 1;
      continue;
    }
    const draft = { userId: null, isViewer: false, isDeliveringExpert: false, name };
    if (side === 'link') linkDrafts.push(draft);
    else drafts[side].push(draft);
  }

  const own = viewerSide(input.lens);
  const order: Array<'client' | 'expert' | 'link'> =
    own === 'client' ? ['client', 'expert', 'link'] : ['expert', 'client', 'link'];
  const labels = {
    client: input.clientPartyLabel,
    expert: input.expertPartyLabel,
    link: JOINED_BY_LINK_LABEL,
  };

  let nextKey = 0;
  const groups: CasePeopleGroupView[] = [];
  for (const side of order) {
    const members = side === 'link' ? linkDrafts : drafts[side];
    const people: CasePersonView[] = [...members].sort(compareDrafts).map((member) => ({
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

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, 'en', { sensitivity: 'base' });
}

function compareDrafts(
  a: DraftPerson & { name: string },
  b: DraftPerson & { name: string }
): number {
  if (a.isViewer !== b.isViewer) return a.isViewer ? -1 : 1;
  if (a.isDeliveringExpert !== b.isDeliveringExpert) return a.isDeliveringExpert ? -1 : 1;
  return compareNames(a.name, b.name);
}
