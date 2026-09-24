import type * as Ably from 'ably';
import {
  isTypingChannelName,
  TYPING_EVENT_STARTED,
  TYPING_EVENT_STOPPED,
  typingSignalFromEventName,
  type TypingSignal,
} from './channels';

/**
 * ⚠⚠ **THE ONE READER OF A `typing:{conversationId}` CHANNEL.**
 *
 * Both realtime hooks (the conversation island's and the in-call panel's) attach typing through
 * this, on the Ably client they ALREADY own — never a second `Ably.Realtime`. The client only
 * READS here: its token is subscribe-only, and the signal is published by the server
 * (`publishTypingSignal`) after the surface's Server Action re-ran its post gate.
 *
 * ⚠ NO `server-only`, AND ONLY `import type` FROM `ably`: it runs inside `'use client'` hooks
 * that import the SDK dynamically, so nothing from the SDK may reach a bundle from here.
 *
 * ── ⚠⚠ WHAT IS READ: A NAME AND THE SERVER-STAMPED `clientId`, NOTHING ELSE ────────────────
 *
 *   · `name` — which of the two signals it is; anything else is ignored;
 *   · `clientId` — who is typing, stamped by the server from the session's `users.id`.
 * ⚠ `data` IS NEVER READ — not rendered, not checked, not touched. The server publishes none,
 * and a reader that never looks cannot be made to render one.
 *
 * ── ⚠ SELF-FILTERING LIVES HERE, AND ONLY HERE ─────────────────────────────────────────────
 *
 * The server fans the viewer's own signal back to them, so their own `clientId` is dropped. That
 * same comparison dedupes the viewer's OTHER TABS for free: every tab of one user shares one
 * `clientId`. This is the only place that knows the viewer's Ably identity, which is why the
 * typing state machine does no self-filtering of its own.
 *
 * ⚠⚠ IT FAILS CLOSED. While `client.auth.clientId` is not a non-empty string, EVERY event is
 * dropped: an unknown self cannot be proved not to be the sender. In practice the window is
 * empty — the hooks build their client with `authCallback` only, and ably-js sets
 * `auth.clientId` from the CONNECTED message's `connectionDetails.clientId` (the token's identity)
 * before it reports `connected` and before any channel attaches, so no channel message can
 * arrive earlier. The rule exists so a future change degrades to "no indicator", never to
 * "you see yourself typing".
 */

export interface TypingChannelHandle {
  /** Unsubscribe, stop re-attaching, detach and release the channel. Idempotent; never throws. */
  release(): void;
}

/** The only two message names this module subscribes to. */
const TYPING_EVENT_NAMES = [TYPING_EVENT_STARTED, TYPING_EVENT_STOPPED] as const;

/**
 * Channel states in which `channels.release()` deletes the channel without detaching it first,
 * i.e. states no live subscription is relying on.
 */
const IDLE_CHANNEL_STATES: ReadonlySet<Ably.ChannelState> = new Set<Ably.ChannelState>([
  'initialized',
  'detached',
  'failed',
]);

/**
 * Channel states ably-js will NOT move out of on its own once the connection is up again:
 * `Channels.onTransportActive` re-attaches only `attaching` / `detaching` / `suspended` /
 * `attached` channels. A typing channel left in one of these is deaf until something attaches it.
 */
const STRANDED_CHANNEL_STATES = IDLE_CHANNEL_STATES;

/** Re-attach backoff after a channel failure: 1 s, 2 s, 4 s … capped. Reset by a good attach. */
export const TYPING_REATTACH_BASE_MS = 1_000;
export const TYPING_REATTACH_CAP_MS = 30_000;

/** Ably's "no capability for this operation". Retrying cannot help until a different token. */
const CAPABILITY_REFUSED = 40160;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

const ignore = (): undefined => undefined;

/**
 * Run one SDK call so that NOTHING escapes it — neither a synchronous throw nor a rejection of
 * the promise it returns. The call itself runs SYNCHRONOUSLY, before this returns; the returned
 * promise settles when the call's own promise does (at once for a `void` call) and never rejects.
 *
 * A typing signal is disposable, so every failure here is the same non-event: no indicator,
 * nothing broken.
 */
function settleQuietly(call: () => unknown): Promise<void> {
  try {
    return Promise.resolve(call()).then(ignore, ignore);
  } catch {
    // A synchronous throw is the same non-event as a rejection — see above.
    return Promise.resolve();
  }
}

/**
 * ⚠⚠ KEEP THE CHANNEL ATTACHED FOR AS LONG AS THE HANDLE LIVES. The implicit attach in
 * `subscribe()` is issued once; two paths leave the channel deaf with the connection reporting
 * `connected`, and ably-js recovers neither:
 *
 *   · ATTACHED WHILE `suspended`. `_attach` fails at once when the connection is not active and
 *     the channel stays `initialized` — a typing-thread switch made while offline for 2+ minutes.
 *     → on every connection `connected`, re-attach a stranded channel.
 *   · FAILED WITHOUT THE CONNECTION. A channel-level error (an undecodable message, a server-side
 *     detach) moves the channel to `failed` while the connection stays `connected`. → re-attach
 *     with backoff ({@link TYPING_REATTACH_BASE_MS} doubling to {@link TYPING_REATTACH_CAP_MS}),
 *     reset by the next good attach.
 *
 * A capability refusal (40160) is NOT retried: that token will refuse every attempt, and the
 * next `connected` covers a later token that grants it again. A failed attach is otherwise never
 * surfaced — no indicator, nothing broken.
 *
 * @returns the function that stops keeping it attached.
 */
function keepAttached(client: Ably.Realtime, channel: Ably.RealtimeChannel): () => void {
  let stopped = false;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const attachIfStranded = (): void => {
    if (stopped || client.connection.state !== 'connected') return;
    if (STRANDED_CHANNEL_STATES.has(channel.state)) settleQuietly(() => channel.attach());
  };

  const onRetry = (): void => {
    retry = null;
    attachIfStranded();
  };

  const onChannelState = (change: Ably.ChannelStateChange): void => {
    if (change.current === 'attached') {
      failures = 0;
      return;
    }
    if (stopped || change.current !== 'failed' || retry !== null) return;
    if (change.reason?.code === CAPABILITY_REFUSED) return;
    const delay = Math.min(TYPING_REATTACH_BASE_MS * 2 ** failures, TYPING_REATTACH_CAP_MS);
    failures += 1;
    retry = setTimeout(onRetry, delay);
  };

  settleQuietly(() => client.connection.on('connected', attachIfStranded));
  settleQuietly(() => channel.on(onChannelState));

  return () => {
    stopped = true;
    if (retry !== null) clearTimeout(retry);
    retry = null;
    settleQuietly(() => client.connection.off('connected', attachIfStranded));
    settleQuietly(() => channel.off(onChannelState));
  };
}

/**
 * Attach the typing channel `channelName` on an EXISTING client and report every inbound signal
 * from somebody else as `(signal, clientId)`.
 *
 * @throws if `channelName` is not in the `typing` namespace — being handed a durable channel here
 * is a programming error, and this reader would misparse its events.
 */
export function attachTypingChannel(
  client: Ably.Realtime,
  channelName: string,
  onSignal: (signal: TypingSignal, clientId: string) => void
): TypingChannelHandle {
  if (!isTypingChannelName(channelName)) {
    throw new Error(`attachTypingChannel: refusing a non-typing channel "${channelName}"`);
  }

  const channel = client.channels.get(channelName);
  let released = false;

  const onMessage = (message: Ably.InboundMessage): void => {
    if (released) return;
    // ⚠⚠ `name` AND `clientId` ONLY. Never `message.data` — see the module docblock.
    const signal = typingSignalFromEventName(message.name);
    if (signal === null) return;
    const sender: unknown = message.clientId;
    // ⚠ READ AT EVENT TIME: ably-js fills it in on CONNECTED, after this handle was created.
    const self: unknown = client.auth.clientId;
    // ⚠ FAIL CLOSED on an unknown self; drop own (and own-other-tab) signals.
    if (!isNonEmptyString(self) || !isNonEmptyString(sender) || sender === self) return;
    onSignal(signal, sender);
  };

  // ⚠ NO `params` — no rewind: a replayed "started" is a phantom typist.
  for (const eventName of TYPING_EVENT_NAMES) {
    settleQuietly(() => channel.subscribe(eventName, onMessage));
  }
  const stopKeepingAttached = keepAttached(client, channel);

  /**
   * ⚠⚠ RELEASE ONLY WHAT NOBODY RE-ATTACHED. `channels.get()` hands a NEWER handle the SAME
   * channel object while this one's detach is still in flight (switching A → B → A, or Strict
   * Mode's synchronous unmount/remount). The newer subscribe supersedes the detach and moves the
   * channel back to `attaching`; releasing it then would drop it from `client.channels.all`, and
   * ably-js routes inbound messages through that map, so the newer handle would go silently deaf.
   * Hence: only a channel that is still idle AND still the one the map holds is released.
   */
  const releaseIfIdle = (): void => {
    if (IDLE_CHANNEL_STATES.has(channel.state) && client.channels.all[channelName] === channel) {
      client.channels.release(channelName);
    }
  };

  return {
    release(): void {
      if (released) return;
      released = true;
      stopKeepingAttached();
      // ⚠ BY LISTENER, NOT `channel.unsubscribe()`: a newer handle may share this channel object.
      for (const eventName of TYPING_EVENT_NAMES) {
        settleQuietly(() => channel.unsubscribe(eventName, onMessage));
      }
      // ⚠ THE DETACH IS ISSUED SYNCHRONOUSLY, so a newer handle's attach that follows in the same
      // tick supersedes it — never the other way round. Release waits for the detach to settle;
      // neither promise in this chain can reject.
      settleQuietly(() => channel.detach()).then(() => settleQuietly(releaseIfIdle));
    },
  };
}
