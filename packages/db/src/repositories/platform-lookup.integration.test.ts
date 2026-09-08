import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as client from '../client';
import { db } from '../client';
import { creditSessions, expertProfiles, partyDomains, users } from '../schema';
import {
  agencyFactory,
  agencyMemberFactory,
  companyFactory,
  companyMemberFactory,
  creditWalletFactory,
  expertDraftFactory,
  expertFactory,
  projectRequestFactory,
  userFactory,
} from '../test/factories';
import { creditSessionsRepository } from './credit-sessions';
import {
  LOOKUP_RESULT_CAP,
  platformLookupRepository,
  type PlatformLookupSearchInput,
} from './platform-lookup';

/**
 * Integration tests for `platformLookupRepository` (BAL-551). Real Postgres 16 via
 * Testcontainers, one auto-rolled-back transaction per test.
 *
 * ⚠ Without Docker this file exits 0 with "No test files" — a FALSE GREEN (memory
 * `reference_integration_tests_false_green_without_docker`). A passing run must show this
 * file by name.
 *
 * Every test seeds a UNIQUE token and searches for it, because the per-test transaction
 * still sees the globally-seeded reference data (verticals, products) and, for a few
 * factories, rows the factory creates for its own FK graph.
 */

/** Every call states the authorization obligation explicitly — that is the point of the flag. */
const AUTHORIZED = { authorizedPlatformStaff: true } as const satisfies Omit<
  PlatformLookupSearchInput,
  'query'
>;

function search(query: string) {
  return platformLookupRepository.search({ query, ...AUTHORIZED });
}

/** A collision-proof token for one test's fixtures. */
let tokenSeq = 0;
function uniqueToken(prefix: string): string {
  tokenSeq++;
  return `${prefix}${tokenSeq}x${Date.now().toString(36)}`;
}

// ── 1-4: the users arm ───────────────────────────────────────────────────────────────

describe('platformLookupRepository.search — users', () => {
  it('matches a user on their full email and on a fragment of it', async () => {
    const token = uniqueToken('mailtok');
    const user = await userFactory({ email: `${token}@northwind.test` });

    const full = await search(`${token}@northwind.test`);
    expect(full.results.map((r) => r.id)).toContain(user.id);

    const partial = await search(token);
    expect(partial.results.map((r) => r.id)).toContain(user.id);
  });

  it('matches a user on first + last concatenated ACROSS the space', async () => {
    const token = uniqueToken('Whitfield');
    const user = await userFactory({ firstName: 'Dana', lastName: token });

    const result = await search(`dana ${token.slice(0, 8)}`);
    const hit = result.results.find((r) => r.id === user.id);
    expect(hit).toBeDefined();
    expect(hit?.type).toBe('user');
    expect(hit?.title).toBe(`Dana ${token}`);
  });

  it('matches a nameless user on email and titles the row from the email', async () => {
    const token = uniqueToken('nameless');
    const user = await userFactory({
      firstName: null,
      lastName: null,
      email: `${token}@solo.test`,
    });

    const result = await search(token);
    const hit = result.results.find((r) => r.id === user.id);
    expect(hit?.title).toBe(`${token}@solo.test`);
  });

  it('excludes a SOFT-DELETED user', async () => {
    const token = uniqueToken('gonetok');
    const user = await userFactory({ email: `${token}@gone.test` });
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, user.id));

    const result = await search(token);
    expect(result.results.map((r) => r.id)).not.toContain(user.id);
  });

  it('composes the sub-line from the live company membership and the active mode', async () => {
    const token = uniqueToken('membertok');
    const user = await userFactory({ firstName: 'Dana', lastName: token });
    const company = await companyFactory({ name: `Northwind ${token}` });
    await companyMemberFactory({ companyId: company.id, userId: user.id, role: 'owner' });

    const result = await search(token);
    const hit = result.results.find((r) => r.type === 'user' && r.id === user.id);
    expect(hit?.sub).toBe(`Owner @ Northwind ${token} · client mode`);
  });
});

// ── 5-8: companies, agencies and the polymorphic party_domains join ──────────────────

describe('platformLookupRepository.search — companies and agencies', () => {
  it('matches a company on name, on companies.domain, and on a party_domains row', async () => {
    const token = uniqueToken('northco');
    const owner = await userFactory();
    const company = await companyFactory({
      name: `${token} Industrial`,
      domain: `${token}-primary.test`,
    });
    await db.insert(partyDomains).values({
      partyType: 'company',
      partyId: company.id,
      domain: `${token}-secondary.test`,
      source: 'auto_captured',
      createdByUserId: owner.id,
    });

    const byName = await search(`${token} Industrial`);
    expect(byName.results.map((r) => r.id)).toContain(company.id);

    const byScalarDomain = await search(`${token}-primary.test`);
    expect(byScalarDomain.results.map((r) => r.id)).toContain(company.id);

    const byRegisteredDomain = await search(`${token}-secondary.test`);
    expect(byRegisteredDomain.results.map((r) => r.id)).toContain(company.id);
  });

  it('matches an AGENCY on a party_domains row — agencies have no domain column', async () => {
    // MUTATION: drop `partyDomainMatches('agency', …)` from the agency arm and this fails.
    const token = uniqueToken('cloudpeak');
    const creator = await userFactory();
    const agency = await agencyFactory({ name: `Agency ${token}` });
    await db.insert(partyDomains).values({
      partyType: 'agency',
      partyId: agency.id,
      domain: `${token}.test`,
      source: 'auto_captured',
      createdByUserId: creator.id,
    });

    const result = await search(`${token}.test`);
    const hit = result.results.find((r) => r.id === agency.id);
    expect(hit?.type).toBe('agency');
    expect(hit?.sub).toContain(`${token}.test`);
  });

  it('does NOT match across the wrong party_type — the polymorphic scope is applied', async () => {
    const token = uniqueToken('wrongtype');
    const creator = await userFactory();
    const agency = await agencyFactory({ name: `Agency ${token}` });
    // A COMPANY-scoped row carrying the AGENCY's id. Nothing may resolve from it.
    await db.insert(partyDomains).values({
      partyType: 'company',
      partyId: agency.id,
      domain: `${token}.test`,
      source: 'auto_captured',
      createdByUserId: creator.id,
    });

    const result = await search(`${token}.test`);
    expect(result.results).toHaveLength(0);
  });

  it('does NOT match a SOFT-DELETED party_domains row', async () => {
    const token = uniqueToken('deleteddom');
    const creator = await userFactory();
    const agency = await agencyFactory({ name: `Agency ${token}` });
    await db.insert(partyDomains).values({
      partyType: 'agency',
      partyId: agency.id,
      domain: `${token}.test`,
      source: 'auto_captured',
      createdByUserId: creator.id,
      deletedAt: new Date(),
      deletedByUserId: creator.id,
    });

    const result = await search(`${token}.test`);
    expect(result.results.map((r) => r.id)).not.toContain(agency.id);
  });

  it('composes the agency sub-line from the live member count and the primary domain', async () => {
    const token = uniqueToken('peakco');
    const creator = await userFactory();
    const agency = await agencyFactory({ name: `Peak ${token}` });
    await agencyMemberFactory({ agencyId: agency.id, userId: creator.id });
    await db.insert(partyDomains).values({
      partyType: 'agency',
      partyId: agency.id,
      domain: `${token}.test`,
      source: 'auto_captured',
      createdByUserId: creator.id,
    });

    const result = await search(`Peak ${token}`);
    const hit = result.results.find((r) => r.id === agency.id);
    expect(hit?.sub).toBe(`Agency · 1 expert · ${token}.test`);
  });

  it('returns a live company even though `companies` has NO deleted_at column', async () => {
    const token = uniqueToken('livecom');
    const company = await companyFactory({ name: `Live ${token}` });
    const wallet = await creditWalletFactory({
      companyId: company.id,
      values: { balanceMinor: 6240 },
    });
    expect(wallet.companyId).toBe(company.id);

    const result = await search(token);
    const hit = result.results.find((r) => r.id === company.id);
    expect(hit?.type).toBe('company');
    expect(hit?.sub).toContain('wallet A$62.40');
  });

  it('says "no wallet yet" for a company with no wallet — not A$0.00', async () => {
    const token = uniqueToken('nowallet');
    const company = await companyFactory({ name: `Bare ${token}` });

    const result = await search(token);
    const hit = result.results.find((r) => r.id === company.id);
    expect(hit?.sub).toContain('no wallet yet');
  });
});

// ── 9-10: the expert arm and the stripped marketplace predicate ──────────────────────

describe('platformLookupRepository.search — expert profiles', () => {
  it('RETURNS an unapproved AND unsearchable expert — the marketplace predicate is stripped', async () => {
    // MUTATION: re-add `eq(expertProfiles.searchable, true)` or
    // `isNotNull(expertProfiles.approvedAt)` to the expert arm and this fails.
    const token = uniqueToken('Draftexp');
    const user = await userFactory({ firstName: 'Priya', lastName: token });
    const draft = await expertDraftFactory({ userId: user.id });

    const result = await search(token);
    const hit = result.results.find((r) => r.type === 'expert' && r.id === draft.id);
    expect(hit).toBeDefined();
    expect(hit?.sub).toContain('not searchable');
    expect(hit?.sub).toContain('draft application');
  });

  it('withholds publicExpertUsername unless the profile is approved AND searchable', async () => {
    const token = uniqueToken('Handleexp');
    const hiddenUser = await userFactory({ firstName: 'Hidden', lastName: token });
    const hidden = await expertDraftFactory({ userId: hiddenUser.id });
    await db
      .update(expertProfiles)
      .set({ username: `hidden-${token}` })
      .where(eq(expertProfiles.id, hidden.id));

    const publicUser = await userFactory({ firstName: 'Public', lastName: token });
    const published = await expertFactory({ userId: publicUser.id });
    await db
      .update(expertProfiles)
      .set({ username: `public-${token}`, searchable: true })
      .where(eq(expertProfiles.id, published.id));

    const result = await search(token);
    const hiddenHit = result.results.find((r) => r.type === 'expert' && r.id === hidden.id);
    const publishedHit = result.results.find((r) => r.type === 'expert' && r.id === published.id);

    expect(hiddenHit?.publicExpertUsername).toBeNull();
    expect(publishedHit?.publicExpertUsername).toBe(`public-${token}`);
    expect(publishedHit?.sub).toContain('approved');
    expect(publishedHit?.sub).toContain('searchable');
  });

  it('matches an expert on their username', async () => {
    const token = uniqueToken('userhandle');
    const user = await userFactory();
    const profile = await expertDraftFactory({ userId: user.id });
    await db
      .update(expertProfiles)
      .set({ username: token })
      .where(eq(expertProfiles.id, profile.id));

    const result = await search(token);
    expect(result.results.map((r) => r.id)).toContain(profile.id);
  });

  it('excludes an expert whose owning user is soft-deleted', async () => {
    const token = uniqueToken('Ghostexp');
    const user = await userFactory({ firstName: 'Ghost', lastName: token });
    const profile = await expertDraftFactory({ userId: user.id });
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, user.id));

    const result = await search(token);
    expect(result.results.map((r) => r.id)).not.toContain(profile.id);
  });

  it('returns TWO rows, user and expert, for a person who is both', async () => {
    const token = uniqueToken('Bothtok');
    const user = await userFactory({ firstName: 'Dana', lastName: token });
    const profile = await expertDraftFactory({ userId: user.id });

    const result = await search(token);
    const mine = result.results.filter((r) => r.id === user.id || r.id === profile.id);
    expect(mine.map((r) => r.type).sort()).toEqual(['expert', 'user']);
  });
});

// ── 11: project requests ─────────────────────────────────────────────────────────────

describe('platformLookupRepository.search — project requests', () => {
  it('matches a request on its title and on its buying company name', async () => {
    const token = uniqueToken('routing');
    const company = await companyFactory({ name: `Buyer ${token}` });
    const request = await projectRequestFactory({
      companyId: company.id,
      title: `Lead ${token} rebuild`,
    });

    const byTitle = await search(`Lead ${token}`);
    expect(byTitle.results.map((r) => r.id)).toContain(request.id);

    const byCompany = await search(`Buyer ${token}`);
    const hit = byCompany.results.find((r) => r.type === 'project_request');
    expect(hit?.id).toBe(request.id);
    expect(hit?.sub).toContain(`Buyer ${token}`);
    expect(hit?.sub).toContain('requested');
  });

  it('excludes a soft-deleted request', async () => {
    const token = uniqueToken('goneReq');
    const request = await projectRequestFactory({
      title: `Dead ${token}`,
      deletedAt: new Date(),
    });

    const result = await search(token);
    expect(result.results.map((r) => r.id)).not.toContain(request.id);
  });
});

// ── 12: credit sessions — the money-safe projection ──────────────────────────────────

const EXPERT_HOURLY = 12_000;

/** Seed one openable credit session. There is no credit-session factory. */
async function seedSession(paymentIntentId: string): Promise<{
  sessionId: string;
  companyId: string;
  expertUserId: string;
}> {
  const { wallet, companyId } = await creditWalletFactory({ values: { balanceMinor: 50_000 } });
  const member = await userFactory();
  const expert = await expertFactory();
  await db
    .update(expertProfiles)
    .set({ rateCents: EXPERT_HOURLY })
    .where(eq(expertProfiles.id, expert.id));

  const opened = await creditSessionsRepository.open({
    walletId: wallet.id,
    companyId,
    expertProfileId: expert.id,
    initiatingMemberId: member.id,
    estimatedMinutes: 10,
  });
  if (!opened.ok) throw new Error(`session seed failed: ${opened.code}`);

  await db
    .update(creditSessions)
    .set({ stripePaymentIntentId: paymentIntentId })
    .where(eq(creditSessions.id, opened.session.id));

  return { sessionId: opened.session.id, companyId, expertUserId: expert.userId };
}

describe('platformLookupRepository.search — credit sessions', () => {
  it('resolves ONE session from its settlement PaymentIntent id, with a fee-free row', async () => {
    const token = uniqueToken('pi3nq');
    const { sessionId } = await seedSession(`pi_3${token}`);

    const result = await search(token);
    const sessions = result.results.filter((r) => r.type === 'credit_session');
    expect(sessions).toHaveLength(1);

    const [row] = sessions;
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.id).toBe(sessionId);

    // MUTATION: widen the arm's projection (or map one more field onto the DTO) and this
    // fails. No fee, no rate, no accrual and no PaymentIntent id may cross this boundary.
    expect(Object.keys(row)).toEqual(['id', 'type', 'title', 'sub', 'publicExpertUsername']);
    expect(JSON.stringify(row)).not.toContain('pi_3');
  });

  it('composes the title and the parties sub-line', async () => {
    const token = uniqueToken('pisub');
    await seedSession(`pi_3${token}`);

    const result = await search(token);
    const [row] = result.results.filter((r) => r.type === 'credit_session');
    expect(row?.title).toContain('Consultation · ');
    expect(row?.title).toContain('— min');
    expect(row?.sub).toContain(' × ');
    expect(row?.sub).toContain('pending');
  });

  it('still finds a session whose expert user is soft-deleted, naming them unavailable', async () => {
    // ⚠ MUTATION: move `isNull(users.deletedAt)` out of the LEFT JOIN condition and into
    // the WHERE clause and this fails — the join collapses to an INNER JOIN and the
    // session disappears from the search entirely (memory
    // `reference_softdelete_join_filter_where_vs_join`). A support person chasing a
    // PaymentIntent must still find the session after the expert's account is removed.
    const token = uniqueToken('pighost');
    const { sessionId, expertUserId } = await seedSession(`pi_3${token}`);
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, expertUserId));

    const result = await search(token);
    const hit = result.results.find((r) => r.id === sessionId);
    expect(hit).toBeDefined();
    expect(hit?.sub).toContain('× expert unavailable');
  });

  it('excludes a soft-deleted session', async () => {
    const token = uniqueToken('pigone');
    const { sessionId } = await seedSession(`pi_3${token}`);
    await db
      .update(creditSessions)
      .set({ deletedAt: new Date() })
      .where(eq(creditSessions.id, sessionId));

    const result = await search(token);
    expect(result.results.map((r) => r.id)).not.toContain(sessionId);
  });
});

// ── 13-15: emails, uuids and the no-prefix ruling ────────────────────────────────────

describe('platformLookupRepository.search — identifiers', () => {
  it('resolves an email to EXACTLY ONE result', async () => {
    const token = uniqueToken('onlyone');
    const user = await userFactory({ email: `${token}@unique.test` });

    const result = await search(`${token}@unique.test`);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.id).toBe(user.id);
  });

  it('resolves a FULL uuid in every arm', async () => {
    const owner = await userFactory();
    const company = await companyFactory();
    const agency = await agencyFactory();
    const profile = await expertDraftFactory();
    const request = await projectRequestFactory();
    const { sessionId } = await seedSession(`pi_3${uniqueToken('uuidarm')}`);

    const cases: readonly [string, string][] = [
      [owner.id, 'user'],
      [company.id, 'company'],
      [agency.id, 'agency'],
      [profile.id, 'expert'],
      [request.id, 'project_request'],
      [sessionId, 'credit_session'],
    ];

    for (const [id, type] of cases) {
      const result = await search(id);
      const hit = result.results.find((r) => r.id === id);
      expect(hit, `uuid did not resolve the ${type} arm`).toBeDefined();
      expect(hit?.type).toBe(type);
    }
  });

  it('resolves NOTHING from a TRUNCATED uuid — there is no prefix match', async () => {
    const company = await companyFactory({ name: `Prefix ${uniqueToken('nopfx')}` });

    const result = await search(company.id.slice(0, 18));
    expect(result.results.map((r) => r.id)).not.toContain(company.id);
  });
});

// ── 16-18: the cap, the round-robin and the minimum length ───────────────────────────

describe('platformLookupRepository.search — the cap and the merge', () => {
  it('caps at 20 and flags truncated when one arm overflows', async () => {
    const token = uniqueToken('bulkco');
    for (let i = 0; i < 30; i++) {
      await companyFactory({ name: `${token} Holdings ${i}` });
    }

    const result = await search(token);
    expect(result.results).toHaveLength(LOOKUP_RESULT_CAP);
    expect(result.truncated).toBe(true);
    expect(result.tooShort).toBe(false);
  });

  it('lets the ONE matching credit session through a full company arm', async () => {
    // MUTATION: swap the round-robin merge for concat-and-slice and this fails — 20
    // companies would fill the cap and the session a support person is hunting vanishes.
    const token = uniqueToken('crowdco');
    for (let i = 0; i < 30; i++) {
      await companyFactory({ name: `${token} Holdings ${i}` });
    }
    const { sessionId } = await seedSession(`pi_3${token}`);

    const result = await search(token);
    expect(result.results).toHaveLength(LOOKUP_RESULT_CAP);
    expect(result.results.map((r) => r.id)).toContain(sessionId);
  });

  it('refuses a one-character query WITHOUT issuing a single arm query', async () => {
    await userFactory({ email: `a${uniqueToken('short')}@short.test` });

    const selectSpy = vi.spyOn(client.db, 'select');
    try {
      const result = await search('a');
      expect(result).toEqual({ results: [], truncated: false, tooShort: true });
      expect(selectSpy).not.toHaveBeenCalled();
    } finally {
      selectSpy.mockRestore();
    }
  });

  it('treats a whitespace-only query as too short', async () => {
    const result = await search('   ');
    expect(result.tooShort).toBe(true);
    expect(result.results).toHaveLength(0);
  });

  it('returns an empty, untruncated, long-enough result when nothing matches', async () => {
    const result = await search(uniqueToken('zznomatch'));
    expect(result).toEqual({ results: [], truncated: false, tooShort: false });
  });
});

// ── 19: LIKE metacharacters are literals ─────────────────────────────────────────────

describe('platformLookupRepository.search — LIKE metacharacters', () => {
  it('treats a typed % as a literal, not a wildcard', async () => {
    const token = uniqueToken('pctco');
    const literal = await companyFactory({ name: `${token} 50% Sale` });
    const decoy = await companyFactory({ name: `${token} 5099 Sale` });

    const result = await search(`${token} 50%`);
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain(literal.id);
    // MUTATION: drop the `%` branch of escapeLikePattern and the decoy matches too.
    expect(ids).not.toContain(decoy.id);
  });

  it('treats a typed _ as a literal, not a single-character wildcard', async () => {
    const token = uniqueToken('underco');
    const literal = await companyFactory({ name: `${token}_Ltd` });
    const decoy = await companyFactory({ name: `${token}XLtd` });

    const result = await search(`${token}_Ltd`);
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain(literal.id);
    // MUTATION: drop the `_` branch of escapeLikePattern and the decoy matches too —
    // which is exactly how `pi_3Nq…` would silently over-match PaymentIntent ids.
    expect(ids).not.toContain(decoy.id);
  });
});
