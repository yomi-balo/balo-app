import { Briefcase, FolderKanban, Layers, SlidersHorizontal, Star, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PLATFORM_CAPABILITIES, type PlatformCapability } from '@balo/shared/authz';

/**
 * BAL-534 — the admin CATALOGUE: a static, CODE-OWNED registry of the admin surfaces that exist
 * or are planned. No table, no query, no CMS — this is documentation that happens to render.
 *
 * ⚠ pending-MJ — every copy string below is flagged for MJ's sign-off queue (called out in the
 * PR body). The wording comes from the design reference `admin-home.jsx:2531-2572`.
 *
 * ⚠ `requiredCapability` is typed against the REAL `PlatformCapability` union — a fictional
 * token cannot be written here. The design reference gates three rows on
 * `MANAGE_PLATFORM_CONFIG`, which DOES NOT EXIST in `packages/shared/src/authz/platform.ts`;
 * those rows are `null` today and gain their token with the D5 bundle split. Do not invent it.
 */

export type CatalogueTone = 'success' | 'warning' | 'neutral';

export interface AdminCatalogueRow {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly href: string;
  readonly icon: LucideIcon;
  /** `null` = no capability gate on this row today. Never a fictional token. */
  readonly requiredCapability: PlatformCapability | null;
  readonly status: string;
  readonly tone: CatalogueTone;
  /** Only a SHIPPED row links — the others point at routes that do not exist (D9). */
  readonly isShipped: boolean;
}

export const ADMIN_CATALOGUE_ROWS: readonly AdminCatalogueRow[] = [
  {
    key: 'projects',
    title: 'Projects', // pending-MJ
    description:
      'The admin portfolio across every client — sourcing, invitations, proposals, kickoff.', // pending-MJ
    href: '/projects?lens=admin',
    icon: FolderKanban,
    requiredCapability: null,
    status: 'Shipped', // pending-MJ
    tone: 'success',
    isShipped: true,
  },
  {
    key: 'platform_config',
    title: 'Platform config', // pending-MJ
    description: 'Consultations card — minimum length, availability look-ahead.', // pending-MJ
    href: '/admin/config',
    icon: SlidersHorizontal,
    requiredCapability: null, // MANAGE_PLATFORM_CONFIG does not exist yet — see the docblock.
    status: 'Not on main yet', // pending-MJ
    tone: 'warning',
    isShipped: false,
  },
  {
    key: 'promo_codes',
    title: 'Promo codes', // pending-MJ
    description: 'Mint, deactivate, track redemptions — the acquisition channel.', // pending-MJ
    href: '/promo-codes',
    icon: Zap,
    requiredCapability: PLATFORM_CAPABILITIES.MANAGE_PROMO_CODES,
    status: 'Shipped', // pending-MJ
    tone: 'success',
    isShipped: true,
  },
  {
    key: 'engagements',
    title: 'Engagements', // pending-MJ
    description: 'Delivery oversight — in flight, in review, gone quiet.', // pending-MJ
    href: '/engagements',
    icon: Briefcase,
    requiredCapability: null,
    status: 'Shipped', // pending-MJ
    tone: 'success',
    isShipped: true,
  },
  {
    key: 'featured_experts',
    title: 'Featured experts', // pending-MJ
    description:
      'Ordered spotlight for the marketing home; consenting, publicly visible experts only.', // pending-MJ
    href: '/admin/config/spotlight',
    icon: Star,
    requiredCapability: null,
    status: 'Designed — BAL-493', // pending-MJ
    tone: 'neutral',
    isShipped: false,
  },
  {
    key: 'taxonomy',
    title: 'Taxonomy', // pending-MJ
    description:
      'Verticals, products, skills, certifications — adding a vertical is a data operation.', // pending-MJ
    href: '/admin/taxonomy',
    icon: Layers,
    requiredCapability: null,
    status: 'Seeded, not editable', // pending-MJ
    tone: 'neutral',
    isShipped: false,
  },
];

export interface ResolvedCatalogueRow extends AdminCatalogueRow {
  /**
   * The viewer may open the surface but not act on it.
   *
   * ⚠ UNREACHABLE IN PRODUCTION TODAY, AND NOT DEAD CODE. `admin` and `super_admin` share ONE
   * `PLATFORM_STAFF_BUNDLE` array reference, so every staff viewer holds every shipped token and
   * this is always `false` in prod. It becomes reachable with the D5 bundle split (MJ holds
   * config/fees; Adeeb does not). It is covered by passing a SYNTHETIC held set to
   * `resolveCatalogueRows` — see `admin-catalogue.test.ts`. Do NOT delete it as unreachable.
   */
  readonly isViewOnly: boolean;
  /** `null` when the destination does not exist yet — the row renders INERT, never a dead link. */
  readonly linkHref: string | null;
}

/**
 * PURE. The whole row→state decision, exported so both branches are testable without a session,
 * a role, or a render.
 *
 * `isViewOnly` and `linkHref` are INDEPENDENT: the design reference lets a gated row still link
 * (view is staff-wide), while D9's "no dead links" rule silences a non-shipped href regardless of
 * capability.
 */
export function resolveCatalogueRows(
  rows: readonly AdminCatalogueRow[],
  heldCapabilities: readonly PlatformCapability[]
): readonly ResolvedCatalogueRow[] {
  return rows.map((row) => ({
    ...row,
    isViewOnly:
      row.requiredCapability !== null && !heldCapabilities.includes(row.requiredCapability),
    linkHref: row.isShipped ? row.href : null,
  }));
}
