'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Building2, UserRound } from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import { track, COMMAND_PALETTE_EVENTS } from '@/lib/analytics';
import { switchWorkspaceAction } from '@/lib/auth/actions/switch-workspace';
import { useSidebar } from './sidebar-context';
import { resolveNavItems, type EnabledNavEntry } from './nav-registry';
import { useNavItemTracking } from './use-nav-item-tracking';
import {
  workspaceDisplayName,
  workspaceSubtitle,
  REPRESENTATION_SWITCH_UNAVAILABLE_NOTE,
} from './workspace-presentation';
import {
  toastWorkspaceSwitchOutcome,
  toastWorkspaceSwitchThrew,
} from './workspace-switch-feedback';
import type { Workspace } from '@balo/shared/workspaces';

/**
 * BAL-500 / ADR-1053 — the ⌘K command palette: trigger pill + global shortcut + dialog listing
 * the current workspace's nav destinations plus "Switch to …" rows for the actor's OTHER
 * workspaces. V1 is navigation-only: no entity search, no recent-items history.
 *
 * ⚠ Its own file, precisely because it must call `useSidebar()` and name `navContext` /
 * `workspaceType` — identifiers `top-nav.tsx` is structurally forbidden to name
 * (`credits-chip-server-gated.test.ts`). `top-nav.tsx` renders this component and nothing else.
 */

interface NavGroupProps {
  readonly heading: string;
  readonly entries: readonly EnabledNavEntry[];
  readonly onSelect: (entry: EnabledNavEntry) => void;
}

function NavGroup({ heading, entries, onSelect }: NavGroupProps): React.JSX.Element | null {
  const [first] = entries; // destructure + guard, never `entries[0]!`
  if (first === undefined) return null; // empty group renders NOTHING, not a bare heading
  return (
    <CommandGroup heading={heading}>
      {entries.map((entry) => {
        const Icon = entry.icon;
        return (
          <CommandItem
            key={entry.key}
            value={entry.label}
            keywords={[entry.key]}
            onSelect={() => onSelect(entry)}
          >
            <Icon aria-hidden="true" />
            <span>{entry.label}</span>
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}

interface WorkspaceRowProps {
  readonly workspace: Workspace;
  readonly actorName: string;
  readonly onSelect: (key: string) => void;
}

function WorkspaceRow({ workspace, actorName, onSelect }: WorkspaceRowProps): React.JSX.Element {
  // Narrowed directly in the `if` (switcher precedent, workspace-switcher.tsx:149-152) so
  // TypeScript carries `CompanyWorkspace` into this branch and `.name` is only reached here.
  if (workspace.type === 'company' && workspace.via === 'representation') {
    return (
      <CommandItem value={workspace.name} keywords={['switch', 'workspace']} disabled>
        <Building2 aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate">{workspace.name}</p>
          <p className="text-muted-foreground truncate text-xs">{workspaceSubtitle(workspace)}</p>
          {/* Visible copy, not a tooltip (balo-ui: never hover-only as the sole explanation), and
              the only way a screen-reader user meets this row — cmdk excludes disabled items from
              arrow navigation, so this text is what browse mode reads.
              ⚠ `text-muted-foreground`, NOT `/80`: `CommandItem` already applies
              `data-[disabled=true]:opacity-50` (command.tsx:133) and alpha reductions COMPOUND —
              identical reasoning to workspace-switcher.tsx:167-171. */}
          <p className="text-muted-foreground mt-0.5 text-[11px]">
            {REPRESENTATION_SWITCH_UNAVAILABLE_NOTE}
          </p>
        </div>
      </CommandItem>
    );
  }
  const Icon = workspace.type === 'expert' ? UserRound : Building2;
  const name = workspaceDisplayName(workspace, actorName);
  return (
    <CommandItem
      value={`Switch to ${name}`}
      keywords={['workspace', workspaceSubtitle(workspace)]}
      onSelect={() => onSelect(workspace.key)}
    >
      <Icon aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate">Switch to {name}</p>
        <p className="text-muted-foreground truncate text-xs">{workspaceSubtitle(workspace)}</p>
      </div>
    </CommandItem>
  );
}

interface PaletteTriggerProps {
  readonly onOpen: () => void;
  /** See the focus-restore effect in `CommandPalette` for why this ref exists. */
  readonly ref: React.Ref<HTMLButtonElement>;
}

function PaletteTrigger({ onOpen, ref }: PaletteTriggerProps): React.JSX.Element {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      aria-keyshortcuts="Meta+K Control+K"
      className="border-border bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring hidden h-8 w-[220px] shrink-0 items-center gap-2 rounded-lg border px-2.5 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none lg:inline-flex"
    >
      <Search className="size-3.5 shrink-0" aria-hidden="true" />
      <span>Search</span>
      {/* `CommandShortcut` supplies `ml-auto` + muted + `text-xs`; the border/mono/size classes
          below win via tailwind-merge, matching the prototype's bordered ⌘K badge. `aria-hidden`
          keeps the button's accessible name exactly "Search" — the shortcut is announced by
          `aria-keyshortcuts` instead. There is no `kbd` primitive in `components/ui/`. */}
      <CommandShortcut
        aria-hidden="true"
        className="border-border bg-background rounded border px-1.5 py-px font-mono text-[10px] tracking-normal"
      >
        ⌘K
      </CommandShortcut>
    </button>
  );
}

export function CommandPalette(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const [, startTransition] = useTransition();
  const { navContext, workspaces, activeWorkspaceKey, userName } = useSidebar();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);
  // F5 — whatever had focus immediately BEFORE the palette opened. Captured synchronously in the
  // two open-triggering handlers below, not reactively in an effect — see the restore effect's
  // comment for why that distinction matters.
  const previouslyFocusedRef = useRef<Element | null>(null);
  const trackNavItem = useNavItemTracking('command_palette', navContext.workspaceType);

  const primaryItems = resolveNavItems(navContext, 'primary');
  const secondaryItems = resolveNavItems(navContext, 'secondary');
  const switchable = workspaces.filter((w) => w.key !== activeWorkspaceKey);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key.toLowerCase() !== 'k') return;
      // ⚠ REQUIRED. ⌘K / Ctrl-K is a browser default (Chrome: focus the omnibox in search mode;
      // Firefox: focus the search bar). Without this the browser chrome steals the keystroke.
      event.preventDefault();
      if (open) {
        setOpen(false);
        return; // a toggle-CLOSE emits nothing — never double-count an open
      }
      // F5 — capture BEFORE setOpen: this is the false→true edge itself, while
      // `document.activeElement` still names whatever the user was in (a form field, the
      // trigger, etc.), not the dialog's own auto-focused search input.
      previouslyFocusedRef.current = globalThis.document.activeElement;
      track(COMMAND_PALETTE_EVENTS.OPENED, { method: 'shortcut' });
      setOpen(true);
    };
    const doc = globalThis.document; // ⚠ globalThis.document — NEVER a bare `window` (S7764)
    doc.addEventListener('keydown', onKeyDown);
    return () => doc.removeEventListener('keydown', onKeyDown);
  }, [open]);

  // ⚠ NOT free, despite Esc-closes being free. `CommandDialog` (`ui/command.tsx`) never renders
  // a `DialogTrigger`, and Radix's `DialogContentModal.onCloseAutoFocus` ONLY restores focus via
  // `context.triggerRef.current?.focus()` — a ref that a real `<DialogTrigger>` instance
  // populates — then calls `event.preventDefault()` UNCONDITIONALLY, which blocks
  // `FocusScope`'s own generic previously-focused-element fallback too
  // (`@radix-ui/react-dialog@1.1.15/dist/index.mjs:176-181`). With a plain trigger `<button>`
  // (required here — `CommandDialog` exposes no slot for a `DialogTrigger`, and `ui/command.tsx`
  // / `ui/dialog.tsx` are off-limits), focus would otherwise land on `<body>` on close. This is
  // the minimal targeted fix, not a redundant Esc handler.
  //
  // F5 — restore to whatever ACTUALLY had focus before opening (`previouslyFocusedRef`), falling
  // back to the trigger only when that element is gone or was never an `HTMLElement`. This is
  // more than cosmetic: opened via ⌘K from a form field, Esc must return focus there per the AC —
  // and since F6 widens the trigger's hidden band to `lg`, on any viewport below that the trigger
  // is CSS-hidden and un-focusable, so a fallback-only-to-trigger design would silently drop focus
  // to `<body>` there.
  //
  // ⚠ The capture is NOT done here, reactively, on the false→true edge — it happens synchronously
  // in the two open-triggering call sites (`handleOpenViaClick`, the shortcut handler above), so
  // the captured value cannot depend on effect-ordering between this component and Radix's
  // `FocusScope` (a descendant, which reads `document.activeElement` and then moves focus into the
  // dialog from inside its own effect). The call site IS the false→true edge, so reading it there
  // is correct however the two components' effects happen to interleave.
  //
  // `<body>` is excluded deliberately. When nothing was focused — a fresh load, a click on
  // non-focusable chrome, or Safari, which does not focus a `<button>` on click —
  // `document.activeElement` is `<body>`, and `body.focus()` is a no-op that would strand focus
  // there. Falling through to the trigger is strictly better in that case.
  useEffect(() => {
    if (wasOpenRef.current && !open) {
      const previous = previouslyFocusedRef.current;
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        previous !== globalThis.document.body
      ) {
        previous.focus();
      } else {
        triggerRef.current?.focus();
      }
    }
    wasOpenRef.current = open;
  }, [open]);

  const handleOpenViaClick = useCallback((): void => {
    // F5 — see the restore effect's comment: captured here, synchronously, before `setOpen`.
    previouslyFocusedRef.current = globalThis.document.activeElement;
    track(COMMAND_PALETTE_EVENTS.OPENED, { method: 'click' });
    setOpen(true);
  }, []);

  const handleNavigate = useCallback(
    (entry: EnabledNavEntry): void => {
      trackNavItem(entry.key); // nav_item_clicked { item, surface:'command_palette', workspace_type }
      // close FIRST; the open→false effect above is what restores focus (Radix does not — no
      // DialogTrigger).
      setOpen(false);
      router.push(entry.href);
    },
    [router, trackNavItem]
  );

  const handleSwitchWorkspace = useCallback(
    (targetKey: string): void => {
      // INTENT, not outcome. The server's `workspace_switched` is the outcome; joining the two
      // gives the palette's switch success rate. Mirrors WORKSPACE_EVENTS.SWITCHER_OPENED's
      // intent grain.
      track(COMMAND_PALETTE_EVENTS.ACTION, { type: 'switch_workspace', destination: targetKey });
      setOpen(false); // ← closes BEFORE the round-trip
      switchWorkspaceAction(targetKey)
        .then(toastWorkspaceSwitchOutcome)
        .catch(toastWorkspaceSwitchThrew)
        .finally(() => startTransition(() => router.refresh()));
    },
    [router]
  );

  return (
    <>
      <PaletteTrigger onOpen={handleOpenViaClick} ref={triggerRef} />
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Command palette"
        description="Search pages and switch workspaces. Use the arrow keys to browse, Enter to select, Escape to close."
        showCloseButton={false}
        className="motion-reduce:animate-none sm:max-w-xl"
      >
        <CommandInput
          placeholder="Search pages and workspaces…"
          aria-label="Search pages and workspaces"
        />
        <CommandList className="max-h-[380px]">
          <CommandEmpty>Try a page name or a workspace name</CommandEmpty>
          <NavGroup heading="Go to" entries={primaryItems} onSelect={handleNavigate} />
          <NavGroup heading="Settings" entries={secondaryItems} onSelect={handleNavigate} />
          {switchable.length > 0 && (
            <>
              {/* Purely decorative — `aria-hidden` keeps it out of the accessibility tree so it
                  never lands as a `role="separator"` child of `CommandList`'s `role="listbox"`
                  (axe `aria-required-children`); the visual divider is unaffected. */}
              <CommandSeparator aria-hidden="true" />
              <CommandGroup heading="Switch workspace">
                {switchable.map((workspace) => (
                  <WorkspaceRow
                    key={workspace.key}
                    workspace={workspace}
                    actorName={userName}
                    onSelect={handleSwitchWorkspace}
                  />
                ))}
              </CommandGroup>
            </>
          )}
        </CommandList>
      </CommandDialog>
    </>
  );
}
