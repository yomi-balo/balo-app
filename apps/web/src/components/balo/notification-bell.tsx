'use client';

import { useCallback, useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Bell, CheckCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { ArrivalToast } from './notification-arrival-toast';
import {
  NOTIFICATION_ARRIVAL_COPY,
  formatRelativeTime,
  type ArrivalSource,
  type BellNotification,
} from './notification-arrival';
import { NotificationKindBadge } from './notification-kind-badge';
import { useNotificationFeed } from './use-notification-feed';
import { useUnreadTabTitle } from './use-unread-tab-title';

const EARLIER_LIMIT = 5;
const BELL_RING_KEYFRAMES = [0, 16, -13, 9, -6, 3, 0];

interface PanelRowProps {
  notification: BellNotification;
  highlighted: boolean;
  onOpen: (notification: BellNotification, source: ArrivalSource) => void;
}

function PanelRow({
  notification,
  highlighted,
  onOpen,
}: Readonly<PanelRowProps>): React.JSX.Element {
  const unread = notification.readAt === null;
  return (
    <button
      type="button"
      data-highlighted={highlighted ? 'true' : undefined}
      className={cn(
        'hover:bg-muted/50 flex w-full items-start gap-3 px-4 py-3 text-left transition-colors',
        highlighted && 'bg-primary/10 motion-safe:transition-colors'
      )}
      onClick={() => onOpen(notification, 'panel')}
    >
      <NotificationKindBadge event={notification.event} size={32} dimmed={!unread} />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'text-[13px] leading-snug',
            unread ? 'text-foreground font-semibold' : 'text-muted-foreground font-medium'
          )}
        >
          {notification.title}
        </p>
        {notification.body && (
          <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs leading-snug">
            {notification.body}
          </p>
        )}
        <p className="text-muted-foreground mt-1 text-xs">
          {formatRelativeTime(notification.createdAt)}
        </p>
      </div>
      {unread && (
        <>
          <span className="bg-primary mt-1.5 size-2 shrink-0 rounded-full" aria-hidden="true" />
          <span className="sr-only">{NOTIFICATION_ARRIVAL_COPY.unread}</span>
        </>
      )}
    </button>
  );
}

function GroupLabel({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <p className="text-muted-foreground px-4 pt-3 pb-1 text-xs font-semibold">{children}</p>;
}

function PanelSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-3 p-4">
      {['a', 'b', 'c'].map((key) => (
        <div key={key} className="flex gap-3">
          <div className="bg-muted h-8 w-8 animate-pulse rounded-full" />
          <div className="flex-1 space-y-2">
            <div className="bg-muted h-3 w-3/4 animate-pulse rounded" />
            <div className="bg-muted h-3 w-1/2 animate-pulse rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function NotificationBell(): React.JSX.Element {
  const {
    notifications,
    unreadCount,
    status,
    toast,
    toastItems,
    ringKey,
    highlightedIds,
    panelOpen,
    openPanel,
    closePanel,
    dismissToast,
    openNotification,
    markAllRead,
    retry,
  } = useNotificationFeed();
  useUnreadTabTitle(unreadCount);
  const shouldReduceMotion = useReducedMotion();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const ringing = ringKey > 0 && !shouldReduceMotion;

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) openPanel('bell');
      else closePanel();
    },
    [openPanel, closePanel]
  );
  const handleToastOpen = useCallback(
    (notification: BellNotification) => openNotification(notification, 'toast'),
    [openNotification]
  );
  const handleToastOpenPanel = useCallback(() => openPanel('toast'), [openPanel]);

  const unread = notifications.filter((n) => n.readAt === null);
  const earlier = notifications.filter((n) => n.readAt !== null).slice(0, EARLIER_LIMIT);
  const badgeLabel = unreadCount > 9 ? '9+' : String(unreadCount);
  const unreadNoun = unreadCount === 1 ? 'notification' : 'notifications';
  const triggerLabel =
    unreadCount > 0 ? `${unreadCount} unread ${unreadNoun}` : NOTIFICATION_ARRIVAL_COPY.panelTitle;

  return (
    <div className="relative">
      <Popover open={panelOpen} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            ref={triggerRef}
            variant="ghost"
            size="icon"
            className="border-border relative border"
            aria-label={triggerLabel}
          >
            <motion.span
              key={`bell-${ringKey}`}
              className="inline-flex"
              style={{ transformOrigin: '50% 3px' }}
              data-ringing={ringing ? 'true' : undefined}
              animate={ringing ? { rotate: BELL_RING_KEYFRAMES } : undefined}
              transition={{ duration: 0.9, ease: 'easeInOut' }}
            >
              <Bell
                className={cn(
                  'h-4 w-4',
                  unreadCount > 0 ? 'text-foreground' : 'text-muted-foreground'
                )}
              />
            </motion.span>
            {unreadCount > 0 && (
              <span className="bg-destructive text-destructive-foreground absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium">
                {ringing && (
                  <span
                    key={`ping-${ringKey}`}
                    aria-hidden="true"
                    data-slot="bell-ping"
                    className="text-destructive animate-ping-slow absolute inset-0 rounded-full [animation-iteration-count:2]"
                  />
                )}
                <span className="relative">{badgeLabel}</span>
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          aria-label={NOTIFICATION_ARRIVAL_COPY.panelTitle}
          className="w-[380px] max-w-[calc(100vw-2rem)] p-0"
        >
          <div className="border-border flex items-center justify-between border-b px-4 py-3">
            <h2 className="text-sm font-semibold">{NOTIFICATION_ARRIVAL_COPY.panelTitle}</h2>
            {unreadCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground h-auto px-2 py-1 text-xs"
                onClick={markAllRead}
              >
                <CheckCheck className="mr-1 h-3 w-3" />
                {NOTIFICATION_ARRIVAL_COPY.markAllRead}
              </Button>
            )}
          </div>

          {status === 'loading' && <PanelSkeleton />}
          {status === 'error' && (
            <div className="flex flex-col items-center gap-2 p-6">
              <p className="text-muted-foreground text-sm">
                {NOTIFICATION_ARRIVAL_COPY.loadFailed}
              </p>
              <Button variant="outline" size="sm" onClick={retry}>
                {NOTIFICATION_ARRIVAL_COPY.retry}
              </Button>
            </div>
          )}
          {status === 'ready' && (
            <ScrollArea className="max-h-96">
              <div className="pb-1.5">
                {unread.length > 0 ? (
                  <>
                    <GroupLabel>{NOTIFICATION_ARRIVAL_COPY.groupNew}</GroupLabel>
                    {unread.map((n) => (
                      <PanelRow
                        key={n.id}
                        notification={n}
                        highlighted={highlightedIds.has(n.id)}
                        onOpen={openNotification}
                      />
                    ))}
                  </>
                ) : (
                  <p className="text-muted-foreground flex items-center gap-2 px-4 pt-4 pb-1.5 text-[13px]">
                    <CheckCheck className="text-success size-4" aria-hidden="true" />
                    {NOTIFICATION_ARRIVAL_COPY.allCaughtUp}
                  </p>
                )}
                {earlier.length > 0 && (
                  <>
                    <GroupLabel>{NOTIFICATION_ARRIVAL_COPY.groupEarlier}</GroupLabel>
                    {earlier.map((n) => (
                      <PanelRow
                        key={n.id}
                        notification={n}
                        highlighted={false}
                        onOpen={openNotification}
                      />
                    ))}
                  </>
                )}
              </div>
            </ScrollArea>
          )}
        </PopoverContent>
      </Popover>
      <ArrivalToast
        toast={toast}
        items={toastItems}
        onOpen={handleToastOpen}
        onOpenPanel={handleToastOpenPanel}
        onDismiss={dismissToast}
        triggerRef={triggerRef}
      />
    </div>
  );
}
