'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LogOut, Check, Shield } from 'lucide-react';
import type { CompanyWorkspace, Workspace } from '@balo/shared/workspaces';
import { SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useSidebar } from './sidebar-context';
import type { EnabledNavEntry } from './nav-registry';
import { useNavItemTracking } from './use-nav-item-tracking';
import { NAV_BADGE_RENDERERS, type NavBadgeCounts } from './nav-badges';
import {
  WorkspaceAvatar,
  WorkspaceLabelStack,
  WORKSPACE_GROUP_LABELS,
  WORKSPACE_SECTION_LABEL_CLASSNAME,
} from './workspace-row-parts';
import {
  workspaceSubtitle,
  REPRESENTATION_SWITCH_UNAVAILABLE_NOTE,
} from './workspace-presentation';
import { useWorkspaceSwitch } from './use-workspace-switch';
import { useLogout } from './use-logout';

interface MobileMoreSheetProps {
  /** `resolveMoreItems(navContext)` — the registry rows, IN ORDER, `account` included at its
   *  natural end-of-list position (D11 — never a hand-placed second row). */
  readonly items: readonly EnabledNavEntry[];
  /** Close-before-act (D25/T-close-before-act): every row calls this FIRST, then its action. */
  readonly onNavigate: () => void;
}

const ROW_CLASSNAME =
  'flex min-h-[44px] w-full items-center gap-3 rounded-lg px-2 text-left text-[15px] font-medium transition-colors active:scale-[0.98] motion-reduce:transition-none focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none';

interface MoreWorkspaceRowProps {
  readonly workspace: Workspace;
  readonly isCurrent: boolean;
  readonly actorName: string;
  readonly actorInitials: string;
  readonly actorAvatarUrl: string | null;
  readonly onSelect: (key: string) => void;
}

/** D5-equivalent for the sheet — a representation row renders `disabled`, with the exact
 *  desktop copy, and NO `onSelect` wired at all (`workspace-switcher.tsx:137-178`). */
function MoreWorkspaceRow({
  workspace,
  isCurrent,
  actorName,
  actorInitials,
  actorAvatarUrl,
  onSelect,
}: Readonly<MoreWorkspaceRowProps>): React.JSX.Element {
  if (workspace.type === 'company' && workspace.via === 'representation') {
    return (
      <button
        type="button"
        disabled
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left disabled:opacity-50"
      >
        <WorkspaceAvatar
          workspace={workspace}
          actorInitials={actorInitials}
          actorAvatarUrl={actorAvatarUrl}
        />
        <div className="min-w-0 flex-1 text-left">
          <p className="truncate text-sm font-medium">{workspace.name}</p>
          {/* `text-muted-foreground`, NOT `/80` — see workspace-switcher.tsx:167-171: alpha
              reductions compound with the parent's own `disabled:opacity-50` dim. */}
          <p className="text-muted-foreground truncate text-xs">{workspaceSubtitle(workspace)}</p>
          <p className="text-muted-foreground mt-0.5 text-[11px]">
            {REPRESENTATION_SWITCH_UNAVAILABLE_NOTE}
          </p>
        </div>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(workspace.key)}
      className="hover:bg-accent focus-visible:ring-ring flex min-h-[44px] w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none active:scale-[0.98] motion-reduce:transition-none"
    >
      <WorkspaceAvatar
        workspace={workspace}
        actorInitials={actorInitials}
        actorAvatarUrl={actorAvatarUrl}
      />
      <WorkspaceLabelStack workspace={workspace} actorName={actorName} />
      {isCurrent && (
        <>
          <Check className="text-primary ml-auto size-3.5 shrink-0" aria-hidden="true" />
          <span className="sr-only">Current workspace</span>
        </>
      )}
    </button>
  );
}

/**
 * BAL-501 — the More sheet's content. Composed top to bottom: drag handle, sr-only title,
 * registry `'more'` rows (§5 step 3), a divider, the Workspace section (§6), a divider, Log out.
 *
 * Reads its own data via `useSidebar()` — the parent `MobileTabBar` passes only `items` (the
 * resolved More list) and `onNavigate` (close the sheet), mirroring `WorkspaceSwitcher`'s own
 * "explicit props for the switcher, its own data for everything else" split (D8).
 */
export function MobileMoreSheet({
  items,
  onNavigate,
}: Readonly<MobileMoreSheetProps>): React.JSX.Element {
  const {
    navContext,
    checklistCompletedCount,
    checklistAllComplete,
    workspaces,
    activeWorkspaceKey,
    userName,
    userInitials,
    userAvatarUrl,
  } = useSidebar();
  const router = useRouter();
  const trackNavItem = useNavItemTracking('more_sheet', navContext.workspaceType);
  const { switchTo } = useWorkspaceSwitch(activeWorkspaceKey);
  const logout = useLogout();

  const badgeCounts: NavBadgeCounts = { checklistCompletedCount, checklistAllComplete };

  // BAL-548 — a stable split of the already-resolved, already-ordered `items` list: everything
  // that isn't the staff-only admin block, and the admin block itself. `resolveMoreItems`
  // returns primary → secondary → admin (registry order), so `.filter()` here preserves that
  // order on both sides — never a re-sort, and never a hand-placed row (BAL-501 D11).
  const primaryish = items.filter((entry) => entry.section !== 'admin');
  const adminItems = items.filter((entry) => entry.section === 'admin');

  const handleItemClick = (entry: EnabledNavEntry) => (): void => {
    onNavigate();
    trackNavItem(entry.key);
  };

  /**
   * BAL-548 (folded from the BAL-534 / PR #285 review, item 2) — one row's markup, extracted so
   * the member rows and the "Balo admin" block below cannot drift (and so jscpd never sees a
   * clone of this Link).
   */
  const renderRow = (entry: EnabledNavEntry): React.JSX.Element => {
    const Icon = entry.icon;
    return (
      <Link
        key={entry.key}
        href={entry.href}
        onClick={handleItemClick(entry)}
        className={cn(ROW_CLASSNAME, 'text-foreground hover:bg-accent')}
      >
        <Icon className="size-[18px] shrink-0" aria-hidden="true" />
        <span className="flex-1">{entry.label}</span>
        {entry.badgeSource !== undefined && NAV_BADGE_RENDERERS[entry.badgeSource](badgeCounts)}
      </Link>
    );
  };

  const handleWorkspaceSelect = (key: string): void => {
    onNavigate();
    switchTo(key);
  };

  const handleLogout = (): void => {
    onNavigate();
    logout();
  };

  const [firstWorkspace] = workspaces; // destructure + guard, never `workspaces[0]!`
  const active =
    firstWorkspace === undefined
      ? null
      : (workspaces.find((w) => w.key === activeWorkspaceKey) ?? firstWorkspace);
  const expertWorkspace = workspaces.find((w) => w.type === 'expert');
  const companyWorkspaces = workspaces.filter((w): w is CompanyWorkspace => w.type === 'company');

  return (
    <SheetContent
      side="bottom"
      className="max-h-[85dvh] gap-1 overflow-y-auto rounded-t-2xl px-3 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] data-[state=open]:duration-300"
    >
      <div
        className="bg-muted-foreground/30 mx-auto mt-1 mb-2 h-1 w-9 rounded-full"
        aria-hidden="true"
      />
      <SheetTitle className="sr-only">More</SheetTitle>

      {/* BAL-548 — partitioned by `entry.section`, preserving `resolveMoreItems`'s registry
          order (primary → secondary → admin), so this is a stable SPLIT, not a re-sort. Never a
          second gate: `entry.section` is a PRESENTATION field (`nav-registry.ts`'s own
          `resolveNavItems` docblock), not an authorization input — the registry's `requires`
          predicate already decided which rows reached `items` at all. */}
      {primaryish.map(renderRow)}

      {/* The desktop sidebar's ONLY labelled group (BAL-534) gets its mobile counterpart here:
          the shield + "Balo admin" heading, rendered ONLY when non-empty (mirrors
          `sidebar.tsx:146`) so a member's sheet gains no bare heading.
          BAL-548 fix round (B-F6) — `text-primary` on BOTH the shield and the label, mirroring
          `sidebar.tsx:156-168`'s own "THE SIDEBAR'S ONLY LABELLED GROUP" treatment. Without it
          this reused `WORKSPACE_SECTION_LABEL_CLASSNAME` renders muted grey, identical to the
          ordinary "Companies" / "Your expert workspace" labels below it, losing the one cue
          that this group is staff-only. */}
      {adminItems.length > 0 && (
        <div data-testid="more-sheet-admin-group">
          <p
            className={cn(
              WORKSPACE_SECTION_LABEL_CLASSNAME,
              'text-primary flex items-center gap-1.5'
            )}
          >
            <Shield className="text-primary size-3" aria-hidden="true" />
            Balo admin
          </p>
          {adminItems.map(renderRow)}
        </div>
      )}

      <div className="border-border my-1.5 border-t" />

      {/* Workspace section — the mobile shell's ONLY surface showing workspace identity, so
          (unlike desktop) it is never hidden even at 0/1 workspaces (design-spec.md §3). */}
      {workspaces.length === 0 && (
        <div className="px-2 py-2">
          <p className={WORKSPACE_SECTION_LABEL_CLASSNAME}>Workspace</p>
          <p className="text-foreground text-sm">We couldn’t find a workspace for your account.</p>
          <Button
            type="button"
            variant="outline"
            className="mt-2 min-h-[44px]"
            onClick={() => router.refresh()}
          >
            Refresh
          </Button>
          <p className="text-muted-foreground mt-2 text-[11px]">
            Still stuck? Sign out and sign back in.
          </p>
        </div>
      )}

      {workspaces.length === 1 && active !== null && (
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <WorkspaceAvatar
            workspace={active}
            actorInitials={userInitials}
            actorAvatarUrl={userAvatarUrl}
          />
          <WorkspaceLabelStack workspace={active} actorName={userName} />
        </div>
      )}

      {workspaces.length >= 2 && (
        <>
          {expertWorkspace !== undefined && (
            <div>
              <p className={WORKSPACE_SECTION_LABEL_CLASSNAME}>{WORKSPACE_GROUP_LABELS.expert}</p>
              <MoreWorkspaceRow
                workspace={expertWorkspace}
                isCurrent={expertWorkspace.key === activeWorkspaceKey}
                actorName={userName}
                actorInitials={userInitials}
                actorAvatarUrl={userAvatarUrl}
                onSelect={handleWorkspaceSelect}
              />
            </div>
          )}
          {companyWorkspaces.length > 0 && (
            <div>
              <p className={WORKSPACE_SECTION_LABEL_CLASSNAME}>
                {WORKSPACE_GROUP_LABELS.companies}
              </p>
              {companyWorkspaces.map((w) => (
                <MoreWorkspaceRow
                  key={w.key}
                  workspace={w}
                  isCurrent={w.key === activeWorkspaceKey}
                  actorName={userName}
                  actorInitials={userInitials}
                  actorAvatarUrl={userAvatarUrl}
                  onSelect={handleWorkspaceSelect}
                />
              ))}
            </div>
          )}
        </>
      )}

      <div className="border-border my-1.5 border-t" />

      <button
        type="button"
        onClick={handleLogout}
        className={cn(ROW_CLASSNAME, 'text-destructive hover:bg-destructive/10')}
      >
        <LogOut className="size-[18px] shrink-0" aria-hidden="true" />
        Log out
      </button>
    </SheetContent>
  );
}
