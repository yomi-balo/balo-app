'use client';

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ChevronsUpDown, Loader2, Check } from 'lucide-react';
import type { CompanyWorkspace, Workspace } from '@balo/shared/workspaces';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { switchWorkspaceAction } from '@/lib/auth/actions/switch-workspace';
import { track, WORKSPACE_EVENTS } from '@/lib/analytics';
import { cn } from '@/lib/utils';
import {
  workspaceDisplayName,
  workspaceInitials,
  workspaceSubtitle,
} from './workspace-presentation';

/**
 * BAL-496 — the sidebar header's workspace switcher. Three render states by list length
 * (D11): 0 → nothing (the header keeps the Logo), 1 → a static non-focusable label, 2+ → a
 * Radix `DropdownMenu`. Representation rows are listed but disabled — never switchable (D5/R1).
 *
 * Takes explicit props rather than reading `useSidebar()` (A8): keeps this directly renderable
 * in isolation for tests, and makes BAL-501's More sheet a second caller with its own data.
 */
export interface WorkspaceSwitcherProps {
  readonly workspaces: readonly Workspace[];
  /** `null` ⇒ nothing to mark as current; implies an empty list once `checkSessionDrift` has run. */
  readonly activeWorkspaceKey: string | null;
  /** D12 — the PERSON's name; the expert workspace has none of its own. */
  readonly actorName: string;
  readonly actorInitials: string;
  readonly actorAvatarUrl: string | null;
  readonly isCollapsed: boolean;
}

interface AvatarProps {
  readonly workspace: Workspace;
  readonly actorInitials: string;
  readonly actorAvatarUrl: string | null;
}

/** Expert row: the actor's photo with initials fallback. Company row: derived initials, no
 *  photo (there is no company avatar field — D12). Mirrors `sidebar.tsx:131-136`. */
function WorkspaceAvatar({
  workspace,
  actorInitials,
  actorAvatarUrl,
}: AvatarProps): React.JSX.Element {
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

interface LabelStackProps {
  readonly workspace: Workspace;
  readonly actorName: string;
}

/** Name (truncating) over subtitle. `min-w-0 flex-1` so the truncate actually engages. */
function WorkspaceLabelStack({ workspace, actorName }: LabelStackProps): React.JSX.Element {
  return (
    <div className="min-w-0 flex-1 text-left">
      <p className="text-sidebar-foreground truncate text-sm font-medium">
        {workspaceDisplayName(workspace, actorName)}
      </p>
      <p className="text-muted-foreground truncate text-xs">{workspaceSubtitle(workspace)}</p>
    </div>
  );
}

interface StaticLabelProps {
  readonly workspace: Workspace;
  readonly actorName: string;
  readonly actorInitials: string;
  readonly actorAvatarUrl: string | null;
  readonly isCollapsed: boolean;
}

/** D11 — length === 1: a plain, non-interactive label. No chevron, no button, no tabIndex,
 *  no role, no menu — nothing focusable, so there is no dead affordance. */
function StaticWorkspaceLabel({
  workspace,
  actorName,
  actorInitials,
  actorAvatarUrl,
  isCollapsed,
}: StaticLabelProps): React.JSX.Element {
  return (
    <div
      // U2 — collapsing the rail hides `WorkspaceLabelStack` entirely, and D11 keeps this
      // wrapper deliberately non-interactive (nothing to hover-reveal via focus or a popover).
      // A native `title` is the low-cost mitigation: it costs no markup, adds no focusable or
      // clickable affordance, and still lets a single-context user identify their workspace on
      // hover while collapsed.
      title={`${workspaceDisplayName(workspace, actorName)} — ${workspaceSubtitle(workspace)}`}
      className={cn(
        'flex items-center rounded-lg',
        isCollapsed ? 'min-h-[44px] min-w-[44px] justify-center' : 'w-full gap-2.5 px-2 py-1.5'
      )}
    >
      <WorkspaceAvatar
        workspace={workspace}
        actorInitials={actorInitials}
        actorAvatarUrl={actorAvatarUrl}
      />
      {!isCollapsed && <WorkspaceLabelStack workspace={workspace} actorName={actorName} />}
    </div>
  );
}

interface WorkspaceRowProps {
  readonly workspace: Workspace;
  readonly isCurrent: boolean;
  readonly actorName: string;
  readonly actorInitials: string;
  readonly actorAvatarUrl: string | null;
  readonly onSelect: (key: string) => void;
}

/** D5 — a representation row renders, disabled, with no `onSelect` wired at all. A click
 *  today would reach `switchWorkspace`'s R1 guard and collapse into a generic "please retry"
 *  toast — for something that can never succeed. Do NOT widen `switchWorkspaceAction` to
 *  surface `AuthResult.code`: that is BAL-314's job. */
function WorkspaceRow({
  workspace,
  isCurrent,
  actorName,
  actorInitials,
  actorAvatarUrl,
  onSelect,
}: WorkspaceRowProps): React.JSX.Element {
  // Narrowed directly in the `if` (rather than through a separately-computed boolean) so
  // TypeScript carries `workspace: CompanyWorkspace` into this branch — `.name` below is only
  // ever reached for a company row.
  if (workspace.type === 'company' && workspace.via === 'representation') {
    return (
      <DropdownMenuItem disabled className="gap-2.5 py-2">
        <WorkspaceAvatar
          workspace={workspace}
          actorInitials={actorInitials}
          actorAvatarUrl={actorAvatarUrl}
        />
        <div className="min-w-0 flex-1 text-left">
          <p className="truncate text-sm font-medium">{workspace.name}</p>
          <p className="text-muted-foreground truncate text-xs">{workspaceSubtitle(workspace)}</p>
          {/* Visible copy, not a tooltip (balo-ui: never hover-only as the sole explanation).
              Also the only way a screen-reader user meets this row — Radix excludes disabled
              items from roving focus, so keyboard arrows skip it; this text stays in the
              accessibility tree for browse mode.
              ⚠ `text-muted-foreground`, NOT `/80` — the parent `DropdownMenuItem` already applies
              `data-[disabled]:opacity-50` (`ui/dropdown-menu.tsx`), and alpha reductions
              COMPOUND. `/80` on top of that parent 50% dim lands around 0.4 effective alpha on an
              already-muted token, likely failing WCAG AA — which would defeat D5/A9's whole
              rationale for choosing visible inline copy over a tooltip. */}
          <p className="text-muted-foreground mt-0.5 text-[11px]">
            Switching here isn’t available yet
          </p>
        </div>
      </DropdownMenuItem>
    );
  }

  return (
    <DropdownMenuItem onSelect={() => onSelect(workspace.key)} className="gap-2.5 py-2">
      <WorkspaceAvatar
        workspace={workspace}
        actorInitials={actorInitials}
        actorAvatarUrl={actorAvatarUrl}
      />
      <WorkspaceLabelStack workspace={workspace} actorName={actorName} />
      {isCurrent && (
        <>
          <Check className="text-primary ml-auto size-3.5 shrink-0" aria-hidden />
          <span className="sr-only">Current workspace</span>
        </>
      )}
    </DropdownMenuItem>
  );
}

function SectionLabel({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <DropdownMenuLabel className="text-muted-foreground px-2 pt-2 pb-1 text-[10px] font-semibold tracking-wider uppercase">
      {children}
    </DropdownMenuLabel>
  );
}

/**
 * The post-switch success toast's copy. Deliberately NOT `workspaceDisplayName` — that helper
 * borrows the actor's own name for the expert row label, but the toast says "your expert
 * workspace" instead of naming the person, which reads oddly in a sentence about switching.
 */
function switchedWorkspaceLabel(workspace: Workspace): string {
  return workspace.type === 'expert' ? 'your expert workspace' : workspace.name;
}

interface WorkspaceMenuProps {
  readonly workspaces: readonly Workspace[];
  readonly active: Workspace;
  readonly activeWorkspaceKey: string | null;
  readonly actorName: string;
  readonly actorInitials: string;
  readonly actorAvatarUrl: string | null;
  readonly isCollapsed: boolean;
}

function WorkspaceMenu({
  workspaces,
  active,
  activeWorkspaceKey,
  actorName,
  actorInitials,
  actorAvatarUrl,
  isCollapsed,
}: WorkspaceMenuProps): React.JSX.Element {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isSwitching, setIsSwitching] = useState(false);

  const handleSelect = useCallback(
    (targetKey: string): void => {
      // No-op guard: selecting the current workspace just closes the menu. `switchWorkspace`
      // short-circuits this server-side too, and emits no analytics, but not calling at all
      // keeps the toast honest — there was no switch.
      if (targetKey === activeWorkspaceKey) return;

      setIsSwitching(true);
      switchWorkspaceAction(targetKey)
        .then((result) => {
          if (result.success) {
            // `AuthResult<T>.data` is typed optional (`data?: T`) even though this action
            // always populates it on success — guard rather than assert (`noUncheckedIndexedAccess`
            // convention: destructure + guard, never `!`). The success TOAST does not depend on
            // it being present: CLAUDE.md requires a toast on every user-initiated mutation, so
            // a successful switch always gets one — `data` only decides which label it gets.
            const { data } = result;
            const label = data === undefined ? 'workspace' : switchedWorkspaceLabel(data.workspace);
            toast.success(`Switched to ${label}`);
            return;
          }
          toast.error(result.error);
        })
        .catch(() => {
          toast.error('Something went wrong. Please try again.');
        })
        .finally(() => {
          setIsSwitching(false);
          // D1 — a BARE `router.refresh()`. `switchWorkspaceAction` already calls
          // `revalidatePath('/', 'layout')` internally on success; this is only what makes the
          // client tree pick the new server render up. Do NOT add a second revalidation, a
          // `window.location` assignment, or a full page reload.
          startTransition(() => router.refresh());
        });
    },
    [activeWorkspaceKey, router]
  );

  const handleOpenChange = useCallback(
    (open: boolean): void => {
      // D6 — MENU OPEN ONLY; the open→switch funnel is the business question. `workspace_count`
      // is every row rendered, INCLUDING the expert row and any DISABLED representation rows.
      if (open) track(WORKSPACE_EVENTS.SWITCHER_OPENED, { workspace_count: workspaces.length });
    },
    [workspaces.length]
  );

  const expertWorkspace = workspaces.find((w) => w.type === 'expert');
  const companyWorkspaces = workspaces.filter((w): w is CompanyWorkspace => w.type === 'company');
  const isBusy = isSwitching || isPending;

  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={isBusy}
          aria-busy={isBusy}
          aria-label={`Switch workspace — currently ${workspaceDisplayName(active, actorName)}`}
          className={cn(
            'ring-offset-background focus-visible:ring-ring hover:bg-sidebar-accent/50 flex items-center rounded-lg border border-transparent transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60',
            'data-[state=open]:bg-sidebar-accent/60 data-[state=open]:border-sidebar-border',
            isCollapsed
              ? 'min-h-[44px] min-w-[44px] justify-center'
              : 'w-full gap-2.5 px-2 py-1.5 text-left'
          )}
        >
          <WorkspaceAvatar
            workspace={active}
            actorInitials={actorInitials}
            actorAvatarUrl={actorAvatarUrl}
          />
          {!isCollapsed && (
            <>
              <WorkspaceLabelStack workspace={active} actorName={actorName} />
              {isBusy ? (
                <Loader2
                  className="text-muted-foreground size-3.5 shrink-0 animate-spin"
                  aria-hidden
                />
              ) : (
                <ChevronsUpDown className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
              )}
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        // D14 — the 56px rail leaves a 40px content box, so a 256px `align="end"` menu would
        // overhang ~200px. `side="right"` is the conventional rail placement and matches how
        // the collapsed nav already handles overflow (`SidebarNavLink`'s tooltips). EXPANDED
        // keeps `align="start"` under the trigger, matching the prototype's
        // `transformOrigin:'top left'`. ⚠ Every other `DropdownMenuContent` in this repo uses
        // `align="end"` (`user-menu.tsx`, `theme-toggle.tsx`, `share-menu.tsx`, …) — none of
        // them is a rail, so this is a deliberate departure, not drift.
        side={isCollapsed ? 'right' : 'bottom'}
        align="start"
        sideOffset={6}
        // D9 — the primitive already does scale .95→1 + fade @150ms with the trigger as
        // transform origin. Do NOT add Motion or a custom keyframe. The missing half is reduced
        // motion: `globals.css` covers Balo's own keyframes plus animate-spin/animate-pulse but
        // NOT animate-in/out — hence `motion-reduce:animate-none` here. Do NOT edit the global
        // block.
        className="w-64 motion-reduce:animate-none"
      >
        {expertWorkspace !== undefined && (
          <DropdownMenuGroup>
            <SectionLabel>Your expert workspace</SectionLabel>
            <WorkspaceRow
              workspace={expertWorkspace}
              isCurrent={expertWorkspace.key === activeWorkspaceKey}
              actorName={actorName}
              actorInitials={actorInitials}
              actorAvatarUrl={actorAvatarUrl}
              onSelect={handleSelect}
            />
          </DropdownMenuGroup>
        )}
        {companyWorkspaces.length > 0 && (
          <DropdownMenuGroup>
            <SectionLabel>Companies</SectionLabel>
            {companyWorkspaces.map((w) => (
              <WorkspaceRow
                key={w.key}
                workspace={w}
                isCurrent={w.key === activeWorkspaceKey}
                actorName={actorName}
                actorInitials={actorInitials}
                actorAvatarUrl={actorAvatarUrl}
                onSelect={handleSelect}
              />
            ))}
          </DropdownMenuGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function WorkspaceSwitcher(props: WorkspaceSwitcherProps): React.JSX.Element | null {
  const [firstWorkspace] = props.workspaces; // destructure + guard, never `workspaces[0]!`
  if (firstWorkspace === undefined) return null; // ── length === 0

  const active = props.workspaces.find((w) => w.key === props.activeWorkspaceKey) ?? firstWorkspace;

  if (props.workspaces.length === 1) {
    return (
      <StaticWorkspaceLabel
        workspace={active}
        actorName={props.actorName}
        actorInitials={props.actorInitials}
        actorAvatarUrl={props.actorAvatarUrl}
        isCollapsed={props.isCollapsed}
      />
    );
  }

  return (
    <WorkspaceMenu
      workspaces={props.workspaces}
      active={active}
      activeWorkspaceKey={props.activeWorkspaceKey}
      actorName={props.actorName}
      actorInitials={props.actorInitials}
      actorAvatarUrl={props.actorAvatarUrl}
      isCollapsed={props.isCollapsed}
    />
  );
}
