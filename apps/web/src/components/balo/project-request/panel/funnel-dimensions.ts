import type { ProjectRequestEntryPoint } from '@balo/shared/project-requests';

/**
 * BAL-582 (D2) — the shared payload shape every panel funnel event
 * (`PROJECT_DRAWER_OPENED` / `PROJECT_STEP_VIEWED` / `PROJECT_ENTRY_SELECTED` /
 * `PROJECT_REQUEST_SUBMITTED`) spreads: `entry_point` always, `expert_id` only when the mount is
 * bound to an expert. A plain conditional spread — never an `expert_id: undefined` key, which
 * would show up in PostHog as a real (if empty) property.
 */
export function projectFunnelDimensions(
  expertProfileId: string | undefined,
  entryPoint: ProjectRequestEntryPoint
): { expert_id?: string; entry_point: ProjectRequestEntryPoint } {
  return {
    ...(expertProfileId === undefined ? {} : { expert_id: expertProfileId }),
    entry_point: entryPoint,
  };
}
