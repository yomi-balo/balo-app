import type { PartyDomainSource, PartyType, StaffDomainAddedVia } from '@balo/db';

export type StaffPartyType = PartyType;

/**
 * The live owner of a domain another party already holds, as the staff form needs it to render
 * the conflict panel and to post back as `expected` on a reassign. Dates are ISO strings so the
 * view crosses the Server Action boundary as plain data.
 */
export interface ConflictOwnerView {
  domainId: string;
  partyType: StaffPartyType;
  partyId: string;
  partyName: string;
  memberCount: number;
  source: PartyDomainSource;
  addedVia: StaffDomainAddedVia;
  createdAt: string;
  createdByName: string | null;
}

export type StaffDomainActionResult =
  | { success: true; message: string }
  | {
      success: false;
      error: string;
      field?: 'domain' | 'reason';
      code?: 'denied' | 'owned_by_other' | 'stale' | 'not_found';
      owner?: ConflictOwnerView;
    };

/** One active domain on the staff page, projected for the browser. */
export interface StaffDomainRowDto {
  id: string;
  domain: string;
  addedVia: StaffDomainAddedVia;
  createdAt: string;
  createdByName: string | null;
  reason: string | null;
}

export interface StaffPartyDto {
  partyType: StaffPartyType;
  partyId: string;
  name: string;
  isPersonal: boolean;
  memberCount: number;
}
