import { db } from '../../client';
import { representations } from '../../schema';
import type { NewRepresentation, Representation } from '../../schema';
import { userFactory } from './user.factory';
import { companyFactory } from './company.factory';

/**
 * Seeds one `representations` row (BAL-313) — an actor (`userFactory`), a granter
 * (`userFactory`) and a company (`companyFactory`), then an ORG-grain grant
 * (`scope: 'org'`, `capabilities: ['participate']`) unless overridden.
 *
 * Inserts DIRECTLY via `db`, never through `representationsRepository.grant()`, so a test
 * can seed ANY state the repository would refuse to produce — a lapsed-but-`active` row, a
 * revoked one with an arbitrary `revoked_by_user_id`, or a raw capability set that bypasses
 * the `REPRESENTABLE_CAPABILITIES` allowlist (what a script or hand-edit looks like). Same
 * rationale as `reschedule-proposal.factory.ts`: the repository's write path is the thing
 * UNDER test, so it must not also be the only route to a fixture.
 *
 * `overrides` merges onto `.values(...)` last, so any field — including `actorUserId`,
 * `onBehalfOfCompanyId`, `scope`, `projectRequestId`, `status`, `expiresAt`, `revokedAt`,
 * `revokedByUserId`, `deletedAt` — can be pinned by the caller; the defaulted `userFactory`/
 * `companyFactory` seeds are skipped entirely when the corresponding id is supplied.
 */
export async function representationFactory(
  overrides: Partial<NewRepresentation> = {}
): Promise<Representation> {
  const actorUserId = overrides.actorUserId ?? (await userFactory()).id;
  const grantedByUserId = overrides.grantedByUserId ?? (await userFactory()).id;
  const onBehalfOfCompanyId = overrides.onBehalfOfCompanyId ?? (await companyFactory()).id;

  const [row] = await db
    .insert(representations)
    .values({
      actorUserId,
      onBehalfOfCompanyId,
      grantedByUserId,
      scope: 'org',
      capabilities: ['participate'],
      ...overrides,
    })
    .returning();
  if (row === undefined) {
    throw new Error('representation insert failed');
  }

  return row;
}
