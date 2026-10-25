'use client';

import { useEffect, useState, type FocusEvent, type KeyboardEvent, type RefObject } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  COLLAPSED_TOAST_MS,
  ITEM_TOAST_MS,
  NOTIFICATION_ARRIVAL_COPY,
  formatRelativeTime,
  notificationActionLabel,
  summariseNotificationTitles,
  type ArrivalToastDismissReason,
  type ArrivalToastState,
  type BellNotification,
} from './notification-arrival';
import { NotificationKindBadge, NotificationKindStack } from './notification-kind-badge';

interface ArrivalToastProps {
  toast: ArrivalToastState | null;
  items: readonly BellNotification[];
  onOpen: (notification: BellNotification) => void;
  onOpenPanel: () => void;
  onDismiss: (reason: ArrivalToastDismissReason) => void;
  /** The bell trigger; keyboard focus returns here when the toast that held it goes away. */
  triggerRef: RefObject<HTMLElement | null>;
}

export function ArrivalToast({
  toast,
  items,
  onOpen,
  onOpenPanel,
  onDismiss,
  triggerRef,
}: Readonly<ArrivalToastProps>): React.JSX.Element {
  const [first] = items;
  const count = toast ? toastCount(toast, items) : 0;
  const collapsed = count >= 2;
  const announcement = first && toast ? announcementText(toast, first, count, collapsed) : '';
  return (
    <div className="absolute top-[calc(100%+0.5rem)] right-0 z-50 w-[360px] max-w-[calc(100vw-2rem)] max-sm:fixed max-sm:inset-x-4 max-sm:top-16 max-sm:w-auto max-sm:max-w-none">
      <output aria-live="polite" className="sr-only">
        {announcement}
      </output>
      {toast && first && (
        <ArrivalToastCard
          toast={toast}
          items={items}
          first={first}
          count={count}
          collapsed={collapsed}
          onOpen={onOpen}
          onOpenPanel={onOpenPanel}
          onDismiss={onDismiss}
          triggerRef={triggerRef}
        />
      )}
    </div>
  );
}

function toastCount(toast: ArrivalToastState, items: readonly BellNotification[]): number {
  return Math.max(items.length, toast.count - (toast.ids.length - items.length));
}

function toastHeading(toast: ArrivalToastState, count: number): string {
  return toast.trigger === 'load'
    ? NOTIFICATION_ARRIVAL_COPY.loadHeading(count)
    : NOTIFICATION_ARRIVAL_COPY.liveHeading(count);
}

/** The text a screen reader announces: the item title, or the collapsed heading. */
function announcementText(
  toast: ArrivalToastState,
  first: BellNotification,
  count: number,
  collapsed: boolean
): string {
  return collapsed ? toastHeading(toast, count) : first.title;
}

function ArrivalToastCard({
  toast,
  items,
  first,
  count,
  collapsed,
  onOpen,
  onOpenPanel,
  onDismiss,
  triggerRef,
}: Readonly<
  ArrivalToastProps & {
    toast: ArrivalToastState;
    first: BellNotification;
    count: number;
    collapsed: boolean;
  }
>): React.JSX.Element {
  const shouldReduceMotion = useReducedMotion();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const duration = collapsed ? COLLAPSED_TOAST_MS : ITEM_TOAST_MS;

  useEffect(() => {
    if (paused) return undefined;
    const timer = setTimeout(() => onDismiss('timeout'), duration);
    return () => clearTimeout(timer);
  }, [paused, duration, toast.key, onDismiss]);

  const handleBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
  };

  const returnFocusToTrigger = (): void => {
    triggerRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return;
    returnFocusToTrigger();
    onDismiss('close');
  };

  const actionLabel = notificationActionLabel(first.actionUrl);
  const heading = toastHeading(toast, count);
  const toastBody = collapsed
    ? summariseNotificationTitles(
        items.map((item) => item.title),
        count
      )
    : first.body;

  return (
    <motion.div
      data-slot="arrival-toast"
      data-animated={shouldReduceMotion ? 'false' : 'true'}
      initial={shouldReduceMotion ? false : { opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.2, 0.8, 0.2, 1] }}
      className="bg-popover border-border relative rounded-2xl border p-3.5 shadow-lg"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="text-muted-foreground absolute top-1.5 right-1.5 size-11 md:size-8"
        aria-label={NOTIFICATION_ARRIVAL_COPY.dismiss}
        onClick={() => {
          returnFocusToTrigger();
          onDismiss('close');
        }}
      >
        <X className="size-3.5" />
      </Button>
      <div className="flex items-start gap-3">
        {collapsed ? (
          <NotificationKindStack items={items} />
        ) : (
          <NotificationKindBadge event={first.event} size={36} />
        )}
        <div className="min-w-0 flex-1 pr-10 md:pr-6">
          <p className="text-sm leading-snug font-semibold">{collapsed ? heading : first.title}</p>
          {toastBody && (
            <p className="text-muted-foreground mt-1 line-clamp-2 text-[13px] leading-snug">
              {toastBody}
            </p>
          )}
          <div className="mt-3 flex items-center gap-3">
            {collapsed ? (
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  returnFocusToTrigger();
                  onOpenPanel();
                }}
              >
                {NOTIFICATION_ARRIVAL_COPY.openNotifications}
              </Button>
            ) : (
              actionLabel && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    returnFocusToTrigger();
                    onOpen(first);
                  }}
                >
                  {actionLabel}
                </Button>
              )
            )}
            <span className="text-muted-foreground text-xs">
              {formatRelativeTime(first.createdAt)}
            </span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
