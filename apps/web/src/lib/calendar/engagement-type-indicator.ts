/**
 * BAL-498 — the Engagement Type Indicator: icon + border colour + label for each meeting
 * context label the expert calendar can render. PURE, client-safe, presentational only — no
 * authorization or data consequence (`plan-bal-498.md` § 18 ADR flags).
 *
 * ⚠ A TOTAL MAP over `MeetingContextTypeWithHolder` (all six holder-bearing labels), so an
 * eighth `meeting_context_type` label added to the shared union is a COMPILE ERROR here rather
 * than a silently blank block. `import type` ONLY from `@balo/shared/meetings` — never a value
 * import of `@balo/db` (memory `reference_balo_db_client_bundle_footgun`).
 *
 * This is the FORWARD source of truth for any future surface rendering mixed engagement-type
 * lists — reuse this mapping rather than re-deriving type-to-colour choices.
 */
import { Video, FolderKanban, Package, Calendar, type LucideIcon } from 'lucide-react';
import type { MeetingContextTypeWithHolder } from '@balo/shared/meetings';

export interface EngagementTypeIndicator {
  readonly icon: LucideIcon;
  /** Tailwind border-color utility applied to the meeting block's 3px left border. */
  readonly borderClass: string;
  readonly label: string;
}

export const ENGAGEMENT_TYPE_INDICATOR: Record<
  MeetingContextTypeWithHolder,
  EngagementTypeIndicator
> = {
  case: { icon: Video, borderClass: 'border-l-primary', label: 'Case' },
  // BAL-511 D5 — `--violet` is a semantic token (`globals.css:45`, dark `:113`, exported as
  // `--color-violet` at `:169`); `violet-500` is a raw Tailwind palette scale literal.
  project_kickoff: { icon: FolderKanban, borderClass: 'border-l-violet', label: 'Project' },
  project_discovery: {
    icon: FolderKanban,
    borderClass: 'border-l-violet',
    label: 'Discovery call',
  },
  request_interaction: {
    icon: FolderKanban,
    borderClass: 'border-l-violet',
    label: 'Intro call',
  },
  package_session: { icon: Package, borderClass: 'border-l-success', label: 'Package' },
  // Reachable through the calendar's data model but produces nothing today (no writer exists
  // for the `retainer` engagement kind) — the future-proof neutral fallback, per design.
  retainer_checkin: { icon: Calendar, borderClass: 'border-l-muted-foreground', label: 'Meeting' },
};
