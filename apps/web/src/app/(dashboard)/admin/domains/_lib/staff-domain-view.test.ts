import { describe, it, expect } from 'vitest';
import {
  addNotifyLine,
  buildStaffDomainRows,
  conflictConsequenceSentence,
  conflictOwnerSentence,
  formatStaffDate,
  listDescription,
  lookupHrefForParty,
  memberCountLabel,
  removeConfirmCopy,
  staffDomainBadge,
  staffDomainMeta,
} from './staff-domain-view';
import type { ConflictOwnerView, StaffDomainRowDto } from './staff-domain-types';

const OWNER: ConflictOwnerView = {
  domainId: 'd1',
  partyType: 'company',
  partyId: 'p1',
  partyName: 'Acme Ltd',
  memberCount: 12,
  source: 'auto_captured',
  addedVia: 'signup',
  createdAt: '2026-10-03T08:00:00.000Z',
  createdByName: 'Dana Lee',
};

const row = (overrides: Partial<StaffDomainRowDto>): StaffDomainRowDto => ({
  id: 'r1',
  domain: 'acme.co.nz',
  addedVia: 'signup',
  createdAt: '2026-10-03T08:00:00.000Z',
  createdByName: 'Dana Lee',
  reason: null,
  ...overrides,
});

describe('formatStaffDate', () => {
  it('renders day, short month and year in UTC', () => {
    expect(formatStaffDate('2026-10-03T23:30:00.000Z')).toBe('3 Oct 2026');
  });
});

describe('staffDomainBadge', () => {
  it('labels each provenance', () => {
    expect(staffDomainBadge('signup')).toEqual({ label: 'From signup', tone: 'signup' });
    expect(staffDomainBadge('balo')).toEqual({ label: 'Added by Balo', tone: 'neutral' });
    expect(staffDomainBadge('party_admin')).toEqual({
      label: 'Added in settings',
      tone: 'neutral',
    });
  });
});

describe('staffDomainMeta', () => {
  it('signup: first mention carries the party, later mentions are bare', () => {
    expect(staffDomainMeta(row({}), 'Acme Ltd', true)).toBe(
      'Captured when Dana Lee @ Acme Ltd signed up on 3 Oct 2026'
    );
    expect(staffDomainMeta(row({}), 'Acme Ltd', false)).toBe(
      'Captured when Dana Lee signed up on 3 Oct 2026'
    );
  });

  it('signup: an unnamed creator reads as a teammate', () => {
    expect(staffDomainMeta(row({ createdByName: null }), 'Acme Ltd', false)).toBe(
      'Captured when a teammate signed up on 3 Oct 2026'
    );
  });

  it('balo: never carries an organisation', () => {
    expect(
      staffDomainMeta(row({ addedVia: 'balo', createdByName: 'Sam Staff' }), 'Acme Ltd', true)
    ).toBe('Added by Sam Staff on 3 Oct 2026');
    expect(staffDomainMeta(row({ addedVia: 'balo', createdByName: null }), 'Acme Ltd', false)).toBe(
      'Added by Balo on 3 Oct 2026'
    );
  });

  it('party_admin: names the person @ party on first mention', () => {
    expect(staffDomainMeta(row({ addedVia: 'party_admin' }), 'Acme Ltd', true)).toBe(
      'Added by Dana Lee @ Acme Ltd on 3 Oct 2026'
    );
    expect(
      staffDomainMeta(row({ addedVia: 'party_admin', createdByName: null }), 'Acme Ltd', false)
    ).toBe('Added by a teammate on 3 Oct 2026');
  });
});

describe('buildStaffDomainRows', () => {
  it('keys the first mention on the creator name; staff rows never consume it', () => {
    const rows = buildStaffDomainRows(
      [
        row({ id: 'a', addedVia: 'balo', createdByName: 'Dana Lee' }),
        row({ id: 'b', addedVia: 'signup', createdByName: 'Dana Lee' }),
        row({ id: 'c', addedVia: 'party_admin', createdByName: 'Dana Lee' }),
        row({ id: 'd', addedVia: 'signup', createdByName: null }),
      ],
      'Acme Ltd'
    );
    expect(rows.map((r) => r.meta)).toEqual([
      'Added by Dana Lee on 3 Oct 2026',
      'Captured when Dana Lee @ Acme Ltd signed up on 3 Oct 2026',
      'Added by Dana Lee on 3 Oct 2026',
      'Captured when a teammate signed up on 3 Oct 2026',
    ]);
    expect(rows.map((r) => r.badge.label)).toEqual([
      'Added by Balo',
      'From signup',
      'Added in settings',
      'From signup',
    ]);
  });

  it('passes the reason through', () => {
    const [first] = buildStaffDomainRows([row({ reason: 'Asked by CFO' })], 'Acme Ltd');
    expect(first?.reason).toBe('Asked by CFO');
  });
});

describe('conflict copy', () => {
  it('describes a signup-captured owner', () => {
    expect(conflictOwnerSentence(OWNER)).toBe(
      'Acme Ltd is a company with 12 members. The domain was captured when Dana Lee @ Acme Ltd signed up on 3 Oct 2026.'
    );
  });

  it('describes an admin-added agency owner with one member', () => {
    expect(
      conflictOwnerSentence({
        ...OWNER,
        partyType: 'agency',
        memberCount: 1,
        source: 'admin_added',
        addedVia: 'balo',
        createdByName: null,
      })
    ).toBe('Acme Ltd is an agency with 1 member. It was added by Balo on 3 Oct 2026.');
  });

  it('names the staff member who added a domain', () => {
    expect(
      conflictOwnerSentence({
        ...OWNER,
        source: 'admin_added',
        addedVia: 'balo',
        createdByName: 'Sam Staff',
      })
    ).toContain('It was added by Sam Staff on 3 Oct 2026.');
  });

  it('describes a legacy party-admin owner with the party and settings', () => {
    expect(
      conflictOwnerSentence({
        ...OWNER,
        source: 'admin_added',
        addedVia: 'party_admin',
        createdByName: 'Lou Legacy',
      })
    ).toBe(
      'Acme Ltd is a company with 12 members. It was added by Lou Legacy @ Acme Ltd in settings on 3 Oct 2026.'
    );
  });

  it('falls back to a party admin for an unnamed legacy owner', () => {
    expect(
      conflictOwnerSentence({
        ...OWNER,
        source: 'admin_added',
        addedVia: 'party_admin',
        createdByName: null,
      })
    ).toContain('It was added by a party admin @ Acme Ltd in settings on');
  });

  it('falls back to a teammate for an unnamed signup', () => {
    expect(conflictOwnerSentence({ ...OWNER, createdByName: null })).toContain(
      'captured when a teammate @ Acme Ltd'
    );
  });

  it('states the reassign consequence', () => {
    expect(conflictConsequenceSentence('acme.co.nz', OWNER, 'Globex')).toBe(
      'Reassigning moves the domain, not the people. New signups with a acme.co.nz email will join Globex; everyone already in Acme Ltd stays where they are.'
    );
  });
});

describe('small builders', () => {
  it('pluralises members', () => {
    expect(memberCountLabel(1)).toBe('1 member');
    expect(memberCountLabel(0)).toBe('0 members');
  });

  it('encodes the lookup link', () => {
    expect(lookupHrefForParty('A & B')).toBe('/admin/lookup?q=A%20%26%20B');
  });

  it('builds the notify line', () => {
    expect(addNotifyLine('Globex', null)).toBe(
      'Owners and admins of Globex get an email and an in-app notice.'
    );
    expect(addNotifyLine('Globex', 'Acme Ltd')).toBe(
      'Owners and admins of Acme Ltd and Globex will be notified.'
    );
  });

  it('builds the remove confirmation copy for last and non-last domains', () => {
    expect(removeConfirmCopy('acme.com', 'Acme', true)).toContain('last domain');
    expect(removeConfirmCopy('acme.com', 'Acme', false)).toContain('People already in Acme stay.');
  });

  it('describes the list per party type', () => {
    expect(listDescription('company', 'Acme')).toContain('based on its join setting');
    expect(listDescription('agency', 'Acme')).toContain('join Acme automatically');
  });
});
