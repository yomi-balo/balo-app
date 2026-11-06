import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-633 — the People card's grouping, placement and concealment rules. `@balo/db` is mocked at
 * the four repository methods the loader reads; everything else is real.
 */

vi.mock('server-only', () => ({}));

const m = {
  listAttendees: vi.fn(),
  listGuests: vi.fn(),
  findNames: vi.fn(),
  listAgencyMembers: vi.fn(),
};

vi.mock('@balo/db', () => ({
  meetingPresenceRepository: {
    listAuthenticatedAttendeesByMeetingIds: (...a: unknown[]) => m.listAttendees(...a),
  },
  meetingGuestsRepository: {
    listRosterNamesForMeetings: (...a: unknown[]) => m.listGuests(...a),
  },
  usersRepository: { findNamesByIds: (...a: unknown[]) => m.findNames(...a) },
  partyMembershipsRepository: { listMemberUserIds: (...a: unknown[]) => m.listAgencyMembers(...a) },
}));

import { log } from '@/lib/logging';
import { JOINED_BY_LINK_LABEL, loadCasePeople, type LoadCasePeopleInput } from './load-case-people';

const VIEWER = 'viewer-1';
const EXPERT = 'expert-1';
const COLLEAGUE = 'colleague-1';
const OBSERVER = 'observer-1';

const NAMES: Record<string, { firstName: string | null; lastName: string | null }> = {
  [VIEWER]: { firstName: 'Dana', lastName: 'Whitfield' },
  [EXPERT]: { firstName: 'Amara', lastName: 'Okafor' },
  [COLLEAGUE]: { firstName: 'Priya', lastName: 'Shah' },
  [OBSERVER]: { firstName: 'Omar', lastName: 'Reyes' },
};

function input(over: Partial<LoadCasePeopleInput> = {}): LoadCasePeopleInput {
  return {
    lens: 'client',
    viewerUserId: VIEWER,
    deliveringExpertUserId: EXPERT,
    deliveringAgencyId: 'agency-1',
    clientPartyLabel: 'Northwind Industrial',
    expertPartyLabel: 'CloudPeak Consulting',
    meetingIds: ['m1', 'm2', 'm3'],
    upcomingMeetingIds: ['m3'],
    ...over,
  };
}

function guest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Guest Person',
    party: 'client',
    inviteChannel: 'email',
    matchedUserId: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.listAttendees.mockResolvedValue([]);
  m.listGuests.mockResolvedValue([]);
  m.listAgencyMembers.mockResolvedValue([]);
  m.findNames.mockImplementation((ids: string[]) =>
    Promise.resolve(
      ids.flatMap((id) => {
        const name = NAMES[id];
        return name === undefined ? [] : [{ id, ...name }];
      })
    )
  );
});

function names(groups: Awaited<ReturnType<typeof loadCasePeople>>, side: string): string[] {
  return groups.find((g) => g.side === side)?.people.map((p) => p.name) ?? [];
}

describe('loadCasePeople — placement', () => {
  it('lists a client colleague who joined on both lenses', async () => {
    m.listAttendees.mockResolvedValue([{ userId: COLLEAGUE, party: 'client' }]);

    const clientLens = await loadCasePeople(input());
    const expertLens = await loadCasePeople(
      input({ lens: 'expert', viewerUserId: EXPERT, deliveringExpertUserId: EXPERT })
    );

    expect(names(clientLens, 'client')).toEqual(['You', 'Priya Shah']);
    expect(names(expertLens, 'client')).toEqual(['Priya Shah']);
  });

  it('puts the viewer first, then the delivering expert, then the rest alphabetically', async () => {
    m.listAttendees.mockResolvedValue([
      { userId: 'zed', party: 'expert' },
      { userId: 'abe', party: 'expert' },
    ]);
    m.findNames.mockResolvedValue([
      { id: EXPERT, firstName: 'Amara', lastName: 'Okafor' },
      { id: 'zed', firstName: 'Zed', lastName: 'Last' },
      { id: 'abe', firstName: 'Abe', lastName: 'First' },
    ]);

    const groups = await loadCasePeople(
      input({ lens: 'expert', viewerUserId: 'abe', deliveringExpertUserId: EXPERT })
    );

    expect(names(groups, 'expert')).toEqual(['You', 'Amara Okafor', 'Zed Last']);
  });

  it('orders groups with the viewer’s side first', async () => {
    const client = await loadCasePeople(input());
    const expert = await loadCasePeople(input({ lens: 'expert', viewerUserId: EXPERT }));
    expect(client.map((g) => g.side)).toEqual(['client', 'expert']);
    expect(expert.map((g) => g.side)).toEqual(['expert', 'client']);
  });

  it('places an observer who is an agency member on the expert side', async () => {
    m.listAttendees.mockResolvedValue([{ userId: OBSERVER, party: 'observer' }]);
    m.listAgencyMembers.mockResolvedValue([OBSERVER]);

    const groups = await loadCasePeople(input());

    expect(names(groups, 'expert')).toContain('Omar Reyes');
    expect(m.listAgencyMembers).toHaveBeenCalledWith('agency', 'agency-1');
  });

  it('does not read agency members when no observer attended', async () => {
    m.listAttendees.mockResolvedValue([{ userId: COLLEAGUE, party: 'client' }]);

    await loadCasePeople(input());

    expect(m.listAgencyMembers).not.toHaveBeenCalled();
  });

  it('omits an observer who is not an agency member (Balo staff)', async () => {
    m.listAttendees.mockResolvedValue([{ userId: OBSERVER, party: 'observer' }]);

    const groups = await loadCasePeople(input());

    expect([...names(groups, 'expert'), ...names(groups, 'client')]).not.toContain('Omar Reyes');
  });

  it('never reads agency members when there is no delivering agency', async () => {
    m.listAttendees.mockResolvedValue([{ userId: OBSERVER, party: 'observer' }]);

    const groups = await loadCasePeople(input({ deliveringAgencyId: null }));

    expect(m.listAgencyMembers).not.toHaveBeenCalled();
    expect(names(groups, 'expert')).not.toContain('Omar Reyes');
  });

  it('omits a user with no name on file rather than falling back to anything', async () => {
    m.listAttendees.mockResolvedValue([{ userId: 'ghost', party: 'client' }]);

    const groups = await loadCasePeople(input());

    expect(names(groups, 'client')).toEqual(['You']);
  });

  it('does not list an independent delivering expert as a row on the client lens', async () => {
    const groups = await loadCasePeople(
      input({ deliveringAgencyId: null, expertPartyLabel: 'Amara Okafor' })
    );
    expect(groups.find((g) => g.side === 'expert')).toMatchObject({
      label: 'Amara Okafor',
      people: [],
    });
  });

  it('lists an independent expert as You, under their own name, on their own lens', async () => {
    const groups = await loadCasePeople(
      input({
        lens: 'expert',
        viewerUserId: EXPERT,
        deliveringAgencyId: null,
        expertPartyLabel: 'Amara Okafor',
      })
    );
    expect(groups[0]).toMatchObject({ label: 'Amara Okafor' });
    expect(names(groups, 'expert')).toEqual(['You']);
  });

  it('still lists an agency-based delivering expert by name', async () => {
    const groups = await loadCasePeople(input());
    expect(names(groups, 'expert')).toEqual(['Amara Okafor']);
  });

  it('shows the label alone for a counterparty with nobody named', async () => {
    const groups = await loadCasePeople(
      input({ lens: 'expert', viewerUserId: EXPERT, deliveringExpertUserId: EXPERT })
    );
    const client = groups.find((g) => g.side === 'client');
    expect(client).toEqual({
      side: 'client',
      label: 'Northwind Industrial',
      people: [],
      unnamedGuestCount: 0,
    });
  });
});

describe('loadCasePeople — guests', () => {
  it('puts a named guest on its party side and counts an unnamed one', async () => {
    m.listGuests.mockResolvedValue([
      guest({ name: 'Remy Guest', party: 'client' }),
      guest({ name: null, party: 'expert' }),
      guest({ name: '   ', party: 'expert' }),
    ]);

    const groups = await loadCasePeople(input());

    expect(names(groups, 'client')).toEqual(['You', 'Remy Guest']);
    expect(groups.find((g) => g.side === 'expert')?.unnamedGuestCount).toBe(2);
  });

  it('puts link-channel guests in the "Joined by link" group, last', async () => {
    m.listGuests.mockResolvedValue([guest({ name: 'Lena Link', inviteChannel: 'link' })]);

    const groups = await loadCasePeople(input());

    const last = groups.at(-1);
    expect(last?.side).toBe('link');
    expect(last?.label).toBe(JOINED_BY_LINK_LABEL);
    expect(last?.people.map((p) => p.name)).toEqual(['Lena Link']);
  });

  it('omits the link group when it holds nobody', async () => {
    const groups = await loadCasePeople(input());
    expect(groups.some((g) => g.side === 'link')).toBe(false);
  });

  it('lists a viewer who was also invited by email once, as You', async () => {
    m.listGuests.mockResolvedValue([guest({ name: 'Dana Whitfield', matchedUserId: VIEWER })]);

    const groups = await loadCasePeople(input());

    expect(names(groups, 'client')).toEqual(['You']);
  });

  it('lists an agency colleague who joined and was email-invited expert-side once', async () => {
    m.listAttendees.mockResolvedValue([{ userId: OBSERVER, party: 'observer' }]);
    m.listAgencyMembers.mockResolvedValue([OBSERVER]);
    m.listGuests.mockResolvedValue([
      guest({ name: 'Omar Reyes', party: 'expert', matchedUserId: OBSERVER }),
    ]);

    const groups = await loadCasePeople(input());

    expect(names(groups, 'expert').filter((n) => n === 'Omar Reyes')).toHaveLength(1);
  });

  it('drops an email guest matched to a member placed on the same side', async () => {
    m.listAttendees.mockResolvedValue([{ userId: COLLEAGUE, party: 'client' }]);
    m.listGuests.mockResolvedValue([
      guest({ name: 'Priya Again', matchedUserId: COLLEAGUE }),
      guest({ name: 'Someone Else' }),
    ]);

    const groups = await loadCasePeople(input());

    expect(names(groups, 'client')).toEqual(['You', 'Priya Shah', 'Someone Else']);
  });

  it('keeps an email guest whose converted user is placed on the OTHER side', async () => {
    m.listAttendees.mockResolvedValue([{ userId: COLLEAGUE, party: 'client' }]);
    m.listGuests.mockResolvedValue([
      guest({ name: 'Cross Side', party: 'expert', matchedUserId: COLLEAGUE }),
    ]);

    const groups = await loadCasePeople(input());

    expect(names(groups, 'expert')).toContain('Cross Side');
  });

  it('drops a link guest whose user is placed on any side', async () => {
    m.listAttendees.mockResolvedValue([{ userId: COLLEAGUE, party: 'client' }]);
    m.listGuests.mockResolvedValue([
      guest({ name: 'Link Dup', inviteChannel: 'link', party: 'expert', matchedUserId: COLLEAGUE }),
    ]);

    const groups = await loadCasePeople(input());

    expect(groups.some((g) => g.side === 'link')).toBe(false);
  });

  it('merges members and named guests into one alphabetical order', async () => {
    m.listAttendees.mockResolvedValue([{ userId: COLLEAGUE, party: 'client' }]);
    m.listGuests.mockResolvedValue([
      guest({ name: 'Zoe Guest' }),
      guest({ name: 'Aaron Guest' }),
      guest({ name: 'Quinn Guest' }),
    ]);

    const groups = await loadCasePeople(input());

    expect(names(groups, 'client')).toEqual([
      'You',
      'Aaron Guest',
      'Priya Shah',
      'Quinn Guest',
      'Zoe Guest',
    ]);
  });

  it('keeps a guest invited by both parties once per side', async () => {
    m.listGuests.mockResolvedValue([
      guest({ name: 'Both Sides', party: 'client' }),
      guest({ name: 'Both Sides', party: 'expert' }),
    ]);

    const groups = await loadCasePeople(input());

    expect(names(groups, 'client')).toContain('Both Sides');
    expect(names(groups, 'expert')).toContain('Both Sides');
  });
});

describe('loadCasePeople — view contract', () => {
  it('assigns unique server keys p0, p1, … across groups in render order', async () => {
    m.listAttendees.mockResolvedValue([{ userId: COLLEAGUE, party: 'client' }]);
    m.listGuests.mockResolvedValue([guest({ name: 'Remy Guest' }), guest({ name: 'Remy Guest' })]);

    const groups = await loadCasePeople(input());
    const keys = groups.flatMap((g) => g.people.map((p) => p.key));

    expect(keys.every((k) => /^p\d+$/.test(k))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(keys.map((_k, i) => `p${i}`));
  });

  it('marks only the viewer and names them "You"', async () => {
    const groups = await loadCasePeople(input());
    const people = groups.flatMap((g) => g.people);
    expect(people.filter((p) => p.isViewer).map((p) => p.name)).toEqual(['You']);
    expect(groups[0]?.people[0]?.isViewer).toBe(true);
  });

  it('puts no email or address-shaped text in the view, even if a row carried one', async () => {
    m.listGuests.mockResolvedValue([
      guest({ name: null, email: 'dana.hidden@northwind.test', emailDomain: 'northwind.test' }),
    ]);
    const serialized = JSON.stringify(await loadCasePeople(input()));
    expect(serialized).not.toContain('@');
    expect(serialized).not.toContain('dana.hidden');
    expect(serialized).not.toContain('northwind.test');
  });
});

describe('loadCasePeople — reads', () => {
  it('issues each repository read at most once, with the full id arrays', async () => {
    m.listAttendees.mockResolvedValue([
      { userId: COLLEAGUE, party: 'client' },
      { userId: OBSERVER, party: 'observer' },
    ]);

    await loadCasePeople(input());

    expect(m.listAttendees).toHaveBeenCalledTimes(1);
    expect(m.listAttendees).toHaveBeenCalledWith(['m1', 'm2', 'm3']);
    expect(m.listGuests).toHaveBeenCalledTimes(1);
    expect(m.listGuests).toHaveBeenCalledWith({
      attendedMeetingIds: ['m1', 'm2', 'm3'],
      seatedMeetingIds: ['m3'],
    });
    expect(m.findNames).toHaveBeenCalledTimes(1);
    expect(m.listAgencyMembers).toHaveBeenCalledTimes(1);
  });

  it('never names the viewer from the database', async () => {
    await loadCasePeople(input());
    const [ids] = m.findNames.mock.calls[0] ?? [[]];
    expect(ids).not.toContain(VIEWER);
  });

  it('returns the fallback groups and logs when a read fails', async () => {
    m.listAttendees.mockRejectedValue(new Error('db down'));

    const groups = await loadCasePeople(input());

    expect(log.error).toHaveBeenCalledWith(
      'Case surface people lookup failed',
      expect.objectContaining({ meetingCount: 3, error: 'db down' })
    );
    expect(groups).toEqual([
      {
        side: 'client',
        label: 'Northwind Industrial',
        people: [{ key: 'p0', name: 'You', isViewer: true }],
        unnamedGuestCount: 0,
      },
      { side: 'expert', label: 'CloudPeak Consulting', people: [], unnamedGuestCount: 0 },
    ]);
  });
});
