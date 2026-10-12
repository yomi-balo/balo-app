import type { ConflictOwnerView, StaffDomainRowDto, StaffPartyType } from './staff-domain-types';

/** Full name from a user's name parts, or `null` when neither is set. */
export function personName(
  person: { firstName: string | null; lastName: string | null } | null
): string | null {
  if (person === null) return null;
  const name = [person.firstName, person.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : null;
}

/** "3 Oct 2026" — the date format used across the staff domains surface. */
export function formatStaffDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export type StaffDomainBadgeTone = 'signup' | 'neutral';

export interface StaffDomainBadge {
  label: string;
  tone: StaffDomainBadgeTone;
}

export function staffDomainBadge(addedVia: StaffDomainRowDto['addedVia']): StaffDomainBadge {
  switch (addedVia) {
    case 'signup':
      return { label: 'From signup', tone: 'signup' };
    case 'balo':
      return { label: 'Added by Balo', tone: 'neutral' };
    case 'party_admin':
      return { label: 'Added in settings', tone: 'neutral' };
    default:
      return addedVia satisfies never;
  }
}

/**
 * The one-line provenance under a domain. The person's "@ {party}" suffix appears on their first
 * mention only; a Balo staff row never carries an organisation.
 */
export function staffDomainMeta(
  row: Pick<StaffDomainRowDto, 'addedVia' | 'createdAt' | 'createdByName'>,
  partyName: string,
  firstMention: boolean
): string {
  const date = formatStaffDate(row.createdAt);
  const suffix = firstMention ? ` @ ${partyName}` : '';
  switch (row.addedVia) {
    case 'signup':
      return `Captured when ${row.createdByName ?? 'a teammate'}${suffix} signed up on ${date}`;
    case 'balo':
      return `Added by ${row.createdByName ?? 'Balo'} on ${date}`;
    case 'party_admin':
      return `Added by ${row.createdByName ?? 'a teammate'}${suffix} on ${date}`;
    default:
      return row.addedVia satisfies never;
  }
}

export interface StaffDomainRowView {
  id: string;
  domain: string;
  badge: StaffDomainBadge;
  meta: string;
  reason: string | null;
}

/**
 * Builds the rendered rows in list order. Which row is a person's first mention is keyed on the
 * creator name for rows that name a party member (signup, party admin); a staff row never
 * consumes a first mention.
 */
export function buildStaffDomainRows(
  rows: readonly StaffDomainRowDto[],
  partyName: string
): StaffDomainRowView[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const named = row.addedVia !== 'balo' && row.createdByName !== null;
    const firstMention = named && !seen.has(row.createdByName ?? '');
    if (named && row.createdByName !== null) seen.add(row.createdByName);
    return {
      id: row.id,
      domain: row.domain,
      badge: staffDomainBadge(row.addedVia),
      meta: staffDomainMeta(row, partyName, firstMention),
      reason: row.reason,
    };
  });
}

const PARTY_ARTICLE: Record<StaffPartyType, string> = {
  company: 'a company',
  agency: 'an agency',
};

export function memberCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'member' : 'members'}`;
}

/** First conflict-panel sentence: who owns the domain and how it got there. */
export function conflictOwnerSentence(owner: ConflictOwnerView): string {
  const date = formatStaffDate(owner.createdAt);
  const intro = `${owner.partyName} is ${PARTY_ARTICLE[owner.partyType]} with ${memberCountLabel(owner.memberCount)}.`;
  if (owner.source === 'auto_captured') {
    return `${intro} The domain was captured when ${owner.createdByName ?? 'a teammate'} @ ${owner.partyName} signed up on ${date}.`;
  }
  return `${intro} It was added by ${owner.createdByName ?? 'Balo'} on ${date}.`;
}

/** Second conflict-panel sentence: reassigning moves the domain, never the people. */
export function conflictConsequenceSentence(
  domain: string,
  owner: ConflictOwnerView,
  targetName: string
): string {
  return `Reassigning moves the domain, not the people. New signups with a ${domain} email will join ${targetName}; everyone already in ${owner.partyName} stays where they are.`;
}

export function lookupHrefForParty(partyName: string): string {
  return `/admin/lookup?q=${encodeURIComponent(partyName)}`;
}

/** The notify line under the add form. */
export function addNotifyLine(targetName: string, conflictOwnerName: string | null): string {
  return conflictOwnerName === null
    ? `Owners and admins of ${targetName} get an email and an in-app notice.`
    : `Owners and admins of ${conflictOwnerName} and ${targetName} will be notified.`;
}

export function removeConfirmCopy(domain: string, partyName: string, isLast: boolean): string {
  return isLast
    ? `This is ${partyName}’s last domain. After this, no one joins ${partyName} by email domain.`
    : `New signups with a ${domain} email won’t join ${partyName}. People already in ${partyName} stay.`;
}

export function listDescription(partyType: StaffPartyType, partyName: string): string {
  return partyType === 'company'
    ? `New signups with a verified email on one of these can join ${partyName}, based on its join setting.`
    : `New signups with a verified email on one of these join ${partyName} automatically.`;
}
