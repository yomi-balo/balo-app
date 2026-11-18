'use client';

import { useEffect, useRef, useState } from 'react';
import type * as Ably from 'ably';
import { createNotificationsRealtimeTokenAction } from '@/lib/notifications/actions/create-notifications-realtime-token';
import { fetchRealtimeToken, type RealtimeTokenResult } from '@/lib/realtime/ably-auth';
import { NOTIFICATIONS_EVENT_CREATED, notificationsChannelName } from '@/lib/realtime/channels';

interface UseNotificationPushArgs {
  /** The signed-in user's id, or `null` where this surface must not hold a connection. */
  userId: string | null;
  /** Called once per `notification.created` ping; the ping carries no payload. */
  onCreated: () => void;
}

const CONNECTION_STATES = [
  'initialized',
  'connecting',
  'connected',
  'disconnected',
  'suspended',
  'closing',
  'closed',
  'failed',
] as const;

const CHANNEL_STATES = [
  'initialized',
  'attaching',
  'attached',
  'detaching',
  'detached',
  'suspended',
  'failed',
] as const;

type ConnectionState = (typeof CONNECTION_STATES)[number];
type ChannelState = (typeof CHANNEL_STATES)[number];

/**
 * The bell's subscribe-only push connection. Reports `pushLive` only while the connection is
 * `connected` AND the notifications channel is `attached`; every other state (connecting, dropped,
 * suspended, failed, a refused token) is `false`, so the feed falls back to its fast poll.
 *
 * `userId === null` creates no client and never loads the `ably` chunk. A message is read by NAME
 * only: it has no payload, and the caller refetches the feed through the authenticated API.
 */
export function useNotificationPush({ userId, onCreated }: Readonly<UseNotificationPushArgs>): {
  pushLive: boolean;
} {
  const [pushLive, setPushLive] = useState(false);
  const onCreatedRef = useRef(onCreated);

  useEffect(() => {
    onCreatedRef.current = onCreated;
  }, [onCreated]);

  useEffect(() => {
    if (userId === null) return;

    let disposed = false;
    let realtime: Ably.Realtime | null = null;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let connectionState: ConnectionState = 'initialized';
    let channelState: ChannelState = 'initialized';

    const publishLiveness = (): void => {
      if (disposed) return;
      setPushLive(connectionState === 'connected' && channelState === 'attached');
    };

    // A refused token (disabled, auth refusal or mint error) ends push for this mount: close on
    // the next tick so Ably never enters its re-auth retry loop, and the feed's poll takes over.
    const fetchToken = async (): Promise<RealtimeTokenResult> => {
      const result = await createNotificationsRealtimeTokenAction();
      if (!result.success) {
        closeTimer = setTimeout(() => realtime?.close(), 0);
      }
      return result;
    };

    const connect = async (): Promise<void> => {
      const AblySdk = await import('ably');
      if (disposed) return;

      const client = new AblySdk.Realtime({
        // Node-callback style — a promise-returning callback fails silently.
        authCallback: (_tokenParams, callback) => fetchRealtimeToken(fetchToken, callback),
      });
      realtime = client;

      for (const state of CONNECTION_STATES) {
        client.connection.on(state, () => {
          connectionState = state;
          publishLiveness();
        });
      }

      const channel = client.channels.get(notificationsChannelName(userId));
      for (const state of CHANNEL_STATES) {
        channel.on(state, () => {
          channelState = state;
          publishLiveness();
        });
      }
      channel
        .subscribe(NOTIFICATIONS_EVENT_CREATED, () => {
          if (!disposed) onCreatedRef.current();
        })
        .catch(() => {
          // An attach failure surfaces through the channel and connection state listeners.
        });
    };

    connect().catch(() => {
      publishLiveness();
    });

    return () => {
      disposed = true;
      clearTimeout(closeTimer);
      realtime?.close();
      realtime = null;
      setPushLive(false);
    };
  }, [userId]);

  return { pushLive: userId !== null && pushLive };
}
