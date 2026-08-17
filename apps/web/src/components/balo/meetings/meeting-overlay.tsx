'use client';

import { X } from 'lucide-react';
import { AlertDialog, Dialog, Popover } from 'radix-ui';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import { MEETING_TOOLBAR_MOBILE_MAX_PX } from '@/lib/meetings/meeting-breakpoints';
import { useMeetingFrameElement } from './meeting-frame-element';

/**
 * BAL-435 — THE THREE OVERLAY SHAPES THE CALL FRAME USES, EACH PORTALED **INTO THE FRAME**.
 *
 * ⚠⚠ BUILT ON `radix-ui` DIRECTLY RATHER THAN ON `components/ui/{sheet,popover,alert-dialog}`,
 * and the reason is structural: those shipped wrappers hard-code their `<Portal>` with no
 * `container` prop, so there is no way to make them render inside the frame element without
 * editing three shared primitives every other surface in the app depends on. One local module
 * that states the rule once is the smaller and safer change — and it means the §8.3 rule has
 * exactly ONE implementation to test.
 *
 * ⚠ ONE MODULE, THREE SHAPES, NO COPY-PASTE. `MeetingMenu` serves BOTH the More sheet and the
 * host's leave menu; `MeetingDialog` serves device settings; `MeetingConfirmDialog` serves
 * end-for-everyone. A fourth caller adds a prop here, never a fourth copy of the markup.
 *
 * ⚠ MOBILE/DESKTOP HERE IS **BEHAVIOUR**, NOT VISIBILITY — a bottom sheet vs an anchored
 * popover — so `useIsMobile` is correct: none of these renders until an interaction, well after
 * its effect has run, so the SSR-safe `false` first render is never seen.
 */

const SCRIM_CLASSES =
  'absolute inset-0 z-40 bg-black/45 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0';

const PANEL_CLASSES =
  'bg-card border-border text-foreground z-50 overflow-hidden border shadow-2xl outline-none';

/**
 * §13.2 — the panel enters from its own origin rather than hard-rendering.
 *
 * ⚠ CSS DATA-STATE ANIMATIONS, NOT `motion/react`: Radix owns the mount/unmount of these nodes,
 * and its own `data-[state]` attributes are the only thing that survives its exit handling.
 * ⚠ `motion-reduce:animate-none` on every one of them (§13.3) — which is also why nothing here
 * depends on the animation to convey that the panel opened.
 */
const PANEL_ENTER_SHEET =
  'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-4 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none';

const PANEL_ENTER_POPOVER =
  'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none';

export interface MeetingMenuProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The control that opens the menu. Rendered as the Radix trigger via `asChild`. */
  readonly trigger: React.ReactNode;
  /** ⚠ Required: an accessible name for the panel itself, not just for its trigger. */
  readonly label: string;
  readonly children: React.ReactNode;
  /**
   * BAL-437 — Radix's "where does focus go when this closes?" hook, forwarded to BOTH shapes.
   *
   * ⚠⚠ IT EXISTS FOR THE CASE WHERE THE **TRIGGER IS NOT FOCUSABLE**. Radix's default is to
   * restore focus to the trigger, which is right for every caller whose trigger is on screen —
   * and wrong for `ReactionPicker`, whose trigger is `hidden md:flex` in exactly the band where
   * this component becomes a Dialog. Restoring focus to a `display: none` node drops it to
   * `<body>`, i.e. a keyboard user tabbing from the top of the page on a live call.
   *
   * ⚠ A CALLER THAT PASSES THIS **MUST** `preventDefault()` AND FOCUS SOMETHING ITSELF — the
   * event is the only chance to place focus, and swallowing it without a target is worse than
   * the default it replaced.
   */
  readonly onCloseAutoFocus?: (event: Event) => void;
}

/**
 * A short list of actions anchored to its trigger.
 *
 * Desktop → an anchored `Popover`, 220px, above the toolbar.
 * Mobile  → a bottom `Dialog` sheet, because a 220px popover at 375px is a modal in denial.
 */
export function MeetingMenu({
  open,
  onOpenChange,
  trigger,
  label,
  children,
  onCloseAutoFocus,
}: Readonly<MeetingMenuProps>): React.JSX.Element {
  const container = useMeetingFrameElement();
  const isMobile = useIsMobile(MEETING_TOOLBAR_MOBILE_MAX_PX);

  if (isMobile) {
    return (
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
        <Dialog.Portal container={container}>
          <Dialog.Overlay className={SCRIM_CLASSES} />
          <Dialog.Content
            aria-label={label}
            onCloseAutoFocus={onCloseAutoFocus}
            className={cn(
              PANEL_CLASSES,
              PANEL_ENTER_SHEET,
              'absolute right-3 bottom-24 left-3 rounded-[20px] p-1.5'
            )}
          >
            {/* ⚠ A TITLE IS MANDATORY for a Radix Dialog; it is visually hidden because the
                trigger already names the menu on screen. Omitting it is an a11y violation the
                axe pass would catch. */}
            <Dialog.Title className="sr-only">{label}</Dialog.Title>
            {children}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal container={container}>
        <Popover.Content
          aria-label={label}
          onCloseAutoFocus={onCloseAutoFocus}
          side="top"
          align="end"
          sideOffset={12}
          className={cn(PANEL_CLASSES, PANEL_ENTER_POPOVER, 'w-[220px] rounded-2xl p-1.5')}
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** One row inside a {@link MeetingMenu}. ⚠ 44px minimum target, on every breakpoint. */
export function MeetingMenuItem({
  icon: Icon,
  label,
  onSelect,
  destructive = false,
  badge = false,
}: Readonly<{
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  /**
   * BAL-403 — a visual attention dot beside the icon. ⚠ THE CALLER'S `label` MUST ALREADY CARRY
   * THE STATE (e.g. "Balance, needs attention") — this dot is `aria-hidden`, exactly like the
   * toolbar's own unread/attention dots, because a purely visual marker is invisible to a
   * screen-reader user.
   */
  badge?: boolean;
}>): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'hover:bg-muted/60 focus-visible:ring-ring flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none',
        destructive ? 'text-destructive' : 'text-foreground'
      )}
    >
      <span className="relative inline-flex shrink-0">
        <Icon
          className={cn('h-[19px] w-[19px]', destructive ? '' : 'text-muted-foreground')}
          aria-hidden
        />
        {badge ? (
          <span
            data-testid="menu-item-attention-dot"
            aria-hidden="true"
            className="bg-primary border-card pointer-events-none absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full border-2"
          />
        ) : null}
      </span>
      {label}
    </button>
  );
}

export interface MeetingDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly children: React.ReactNode;
}

/**
 * A modal panel. Bottom sheet below `md`, centred card above it.
 *
 * ⚠ SAME PORTAL CONTAINER RULE. See `meeting-frame-element.tsx`.
 */
export function MeetingDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: Readonly<MeetingDialogProps>): React.JSX.Element {
  const container = useMeetingFrameElement();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={container}>
        <Dialog.Overlay className={SCRIM_CLASSES} />
        <Dialog.Content
          className={cn(
            PANEL_CLASSES,
            PANEL_ENTER_SHEET,
            'absolute right-0 bottom-0 left-0 max-h-[85%] overflow-y-auto rounded-t-[20px] p-6',
            'md:top-1/2 md:right-auto md:bottom-auto md:left-1/2 md:w-full md:max-w-[425px] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl'
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <Dialog.Title className="text-foreground text-base font-semibold">{title}</Dialog.Title>
            {/*
              ⚠⚠ A VISIBLE CLOSE CONTROL, because Esc and an outside tap are not discoverable.
              At 375px this is a bottom sheet occupying `max-h-[85%]`, so "tap the sliver of scrim
              above the sheet" is not a control anybody finds — and this is the one modal a person
              opens DELIBERATELY and expects to confirm their way out of. 44px target, named.
            */}
            <Dialog.Close
              aria-label="Close"
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring -mt-1 -mr-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </Dialog.Close>
          </div>
          {description === undefined ? null : (
            <Dialog.Description className="text-muted-foreground mt-1 text-[13px] leading-relaxed">
              {description}
            </Dialog.Description>
          )}
          <div className="mt-5">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export interface MeetingConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly body: React.ReactNode;
  readonly confirmLabel: string;
  readonly pendingLabel: string;
  readonly isPending: boolean;
  readonly onConfirm: () => void;
}

/**
 * The destructive confirm.
 *
 * ⚠⚠ **FOCUS LANDS ON CANCEL, NOT CONFIRM.** A destructive default focus plus a stray Enter ends
 * a live call for everybody in it. Radix autofocuses the first focusable node, so Cancel is
 * rendered FIRST in the DOM — and, since Cancel-left / Confirm-right is ALSO the wanted visual
 * order, DOM order *is* visual order here and no ordering class is needed. ⚠ If a future edit
 * wants Confirm on the left, reorder with CSS (`order-*`), never by swapping the markup back:
 * the markup order is what puts focus on the safe choice.
 */
export function MeetingConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  pendingLabel,
  isPending,
  onConfirm,
}: Readonly<MeetingConfirmDialogProps>): React.JSX.Element {
  const container = useMeetingFrameElement();

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal container={container}>
        <AlertDialog.Overlay className={SCRIM_CLASSES} />
        <AlertDialog.Content
          className={cn(
            PANEL_CLASSES,
            PANEL_ENTER_POPOVER,
            'absolute top-1/2 left-1/2 w-[calc(100%-2rem)] max-w-[425px] -translate-x-1/2 -translate-y-1/2 rounded-2xl p-6'
          )}
        >
          <AlertDialog.Title className="text-foreground text-base font-semibold">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="text-muted-foreground mt-2 space-y-2 text-[13px] leading-relaxed">
              {body}
            </div>
          </AlertDialog.Description>
          <div className="mt-6 flex items-center justify-end gap-2">
            {/* ⚠ CANCEL IS FIRST IN THE DOM **ON PURPOSE** — see the docblock. */}
            <AlertDialog.Cancel
              className="border-border text-foreground hover:bg-muted/60 focus-visible:ring-ring inline-flex min-h-11 items-center justify-center rounded-lg border px-4 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
              disabled={isPending}
            >
              Cancel
            </AlertDialog.Cancel>
            <AlertDialog.Action
              onClick={(event) => {
                // ⚠ THE DIALOG STAYS OPEN WHILE THE ACTION RUNS, so the pending label is visible.
                event.preventDefault();
                onConfirm();
              }}
              disabled={isPending}
              className="bg-destructive text-destructive-foreground focus-visible:ring-ring inline-flex min-h-11 items-center justify-center rounded-lg px-4 text-sm font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none disabled:opacity-80"
            >
              {isPending ? pendingLabel : confirmLabel}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
