'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import type { Workspace } from '@balo/shared/workspaces';
import {
  workspaceDisplayName,
  workspaceInitials,
  workspaceSubtitle,
} from './workspace-presentation';

/**
 * BAL-501 (D8) — `WorkspaceAvatar` / `WorkspaceLabelStack` extracted VERBATIM from
 * `workspace-switcher.tsx` so `mobile-more-sheet.tsx` can render identical workspace rows
 * without importing `workspace-switcher.tsx` itself (which value-imports the Radix
 * `DropdownMenu` barrel, `switchWorkspaceAction`, `sonner` and `next/navigation` — dragging the
 * whole dropdown into the sheet's chunk). Classes are UNCHANGED, so `workspace-switcher.test.tsx`
 * stays green with zero edits — that identity is this extraction's proof.
 *
 * `StaticWorkspaceLabel` is NOT extracted here — its `title` attribute and `isCollapsed`
 * behaviour are rail-specific (`workspace-switcher.tsx:106-116`).
 */

/** BAL-496/D3 — reused verbatim by the sidebar switcher and BAL-501's More sheet. */
export const WORKSPACE_GROUP_LABELS = {
  expert: 'Your expert workspace',
  companies: 'Companies',
} as const;

/** BAL-501 fix round (C2) — the section-label class string, deduplicated between
 *  `workspace-switcher.tsx`'s `DropdownMenuLabel` and `mobile-more-sheet.tsx`'s `<p>`. */
export const WORKSPACE_SECTION_LABEL_CLASSNAME =
  'text-muted-foreground px-2 pt-2 pb-1 text-[10px] font-semibold tracking-wider uppercase';

export interface WorkspaceAvatarProps {
  readonly workspace: Workspace;
  readonly actorInitials: string;
  readonly actorAvatarUrl: string | null;
}

/** Expert row: the actor's photo with initials fallback. Company row: derived initials, no
 *  photo (there is no company avatar field — D12). */
export function WorkspaceAvatar({
  workspace,
  actorInitials,
  actorAvatarUrl,
}: WorkspaceAvatarProps): React.JSX.Element {
  const initials = workspaceInitials(workspace, actorInitials);
  return (
    <Avatar className="size-7 shrink-0 rounded-lg">
      {workspace.type === 'expert' && actorAvatarUrl !== null && (
        <AvatarImage src={actorAvatarUrl} alt="" />
      )}
      <AvatarFallback className="bg-primary/10 text-primary rounded-lg text-[11px] font-semibold">
        {initials}
      </AvatarFallback>
    </Avatar>
  );
}

export interface WorkspaceLabelStackProps {
  readonly workspace: Workspace;
  readonly actorName: string;
}

/** Name (truncating) over subtitle. `min-w-0 flex-1` so the truncate actually engages. */
export function WorkspaceLabelStack({
  workspace,
  actorName,
}: WorkspaceLabelStackProps): React.JSX.Element {
  return (
    <div className="min-w-0 flex-1 text-left">
      <p className="text-sidebar-foreground truncate text-sm font-medium">
        {workspaceDisplayName(workspace, actorName)}
      </p>
      <p className="text-muted-foreground truncate text-xs">{workspaceSubtitle(workspace)}</p>
    </div>
  );
}
