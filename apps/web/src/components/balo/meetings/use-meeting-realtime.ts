'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as Ably from 'ably';
import { fetchRealtimeToken } from '@/lib/realtime/ably-auth';
import {
  CONVERSATION_EVENT_MESSAGE,
  MEETING_EVENT_FILE,
  MEETING_EVENT_REACTION,
} from '@/lib/realtime/channels';
import {
  isMeetingReactionPayload,
  type MeetingReactionEmoji,
  type MeetingReactionPayload,
} from '@/lib/meetings/meeting-reactions';
import type { MeetingFileView } from '@/lib/meetings/meeting-file-view-types';
import type { MeetingRealtimeRegistration } from '@/lib/meetings/meeting-panels';
import type { ConversationMessageView } from '@/lib/conversations/conversation-view-types';
// ⚠ BAL-437 — FROM `lib/realtime`, NOT from the conversation feature's hook. These are
// transport-level primitives; the call surface must not reach into a project-request/case
// module for them. See `message-payload.ts`'s docblock.
import {
  isConversationMessagePayload,
  sanitizeRealtimeBodyHtml,
} from '@/lib/realtime/message-payload';

/**
 * BAL-437 — ⚠⚠ **ONE ABLY CLIENT FOR THE WHOLE CALL, MOUNTED AT FRAME LEVEL.**
 *
 * Not in the Chat panel, and the reason is not tidiness: reactions render over the STAGE while
 * the panel is closed, the Files panel needs the same connection, and inbound chat must be
 * buffered while the panel is unmounted. One client per call is also what Ably bills and what
 * the vendor skill's "don't create a new client on every render" rule points at.
 *
 * ── ⚠⚠ THE TRUST BOUNDARY ───────────────────────────────────────────────────────────────
 *
 * Channel payloads arrive as `unknown` FROM A THIRD PARTY. Every consumed field is structurally
 * type-checked, and message `bodyHtml` is re-sanitised client-side
 * (`sanitizeRealtimeBodyHtml`) before the panel may render it through
 * `dangerouslySetInnerHTML` — even though the server only ever publishes sanitised view models,
 * a compromised key or channel must degrade to INERT TEXT, never to script execution and never
 * to an arbitrary glyph floating over live video.
 *
 * ── ⚠⚠ **NO `rewind`. READ THIS BEFORE ADDING `params`.** ───────────────────────────────
 *
 * The vendor skill suggests `params: { rewind: '2m' }` so returning clients see recent
 * messages. On THIS channel it is a defect: Ably replays the window on EVERY reattach, so a
 * single reconnect would re-float every reaction from the last two minutes at once, over
 * somebody's face, with no way to tell replays from live taps. The shipped conversation hook
 * passes no `params` and is safe by omission — keep it that way. Chat needs no rewind either:
 * it has a durable record and re-reads its page on open.
 *
 * ⚠ THE SUBSCRIBE-ONLY TOKEN IS WHY THERE IS NO `echoMessages: false`. The client never
 * publishes, so it cannot echo. The sender receives their own reaction ONLY via the server
 * fan-out — which is exactly why the nonce dedupe exists.
 *
 * ⚠ THE `ably` SDK IS DYNAMICALLY IMPORTED inside the effect: never in the initial bundle of a
 * call page, never evaluated during SSR.
 */

/**
 * ⚠⚠ `'connecting'` AND `'reconnecting'` ARE **DIFFERENT FACTS**, NOT A STYLE CHOICE.
 *
 * The first connect of a call is `'connecting'`; a drop AFTER a successful connect is
 * `'reconnecting'`. They used to be one value, so the panel told everyone *"Reconnecting…"*
 * during their very first second on the call — before there had ever been a connection to
 * re-establish. That reads as "something already broke", which is both untrue and alarming on
 * a surface where the person is simultaneously trying to work out whether their camera is on.
 */
export type MeetingRealtimeStatus =
  | 'disabled'
  | 'connecting'
  | 'reconnecting'
  | 'connected'
  | 'failed';

/**
 * STRUCTURAL guard over an inbound `meeting_files` row.
 *
 * ⚠ NAMING A FIELD WRONG HERE REJECTS EVERY INBOUND FILE **SILENTLY** — the payload is
 * `unknown`, so a green typecheck cannot catch it. Every field the chat row and the Files
 * panel consume is checked.
 */
export function isMeetingFilePayload(data: unknown): data is MeetingFileView {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  const strings = [
    'id',
    'meetingId',
    'fileName',
    'contentType',
    'party',
    'source',
    'uploadedByUserId',
    'createdAtIso',
  ];
  return (
    strings.every((key) => typeof record[key] === 'string') && typeof record.sizeBytes === 'number'
  );
}

export interface UseMeetingRealtimeInput {
  /** ⚠ `null` ⇒ NO TRANSPORT AT ALL: terminal `'disabled'`, no client, no retry loop. */
  readonly registration: MeetingRealtimeRegistration | null;
  readonly onMessage: (message: ConversationMessageView) => void;
  readonly onFile: (file: MeetingFileView) => void;
  readonly onReaction: (reaction: MeetingReactionPayload) => void;
}

/**
 * The raw transport: one client, up to two channels, three event names.
 *
 * ⚠ HANDLERS ARE HELD IN REFS so a re-render never tears down and re-subscribes a channel —
 * flapping subscriptions look like flapping connectivity rather than like a bug, and would be
 * found in production rather than in review.
 */
export function useMeetingRealtime(input: UseMeetingRealtimeInput): {
  status: MeetingRealtimeStatus;
} {
  const { registration, onMessage, onFile, onReaction } = input;
  const [status, setStatus] = useState<MeetingRealtimeStatus>(
    registration === null ? 'disabled' : 'connecting'
  );

  const onMessageRef = useRef(onMessage);
  const onFileRef = useRef(onFile);
  const onReactionRef = useRef(onReaction);
  const fetchTokenRef = useRef(registration?.fetchToken);

  /**
   * ⚠⚠ **ONE REF-SYNC CONVENTION IN THIS FILE: AN EFFECT, NEVER A RENDER-PHASE WRITE.**
   *
   * `fetchTokenRef` used to be assigned during render, twenty lines below this effect — two
   * conventions for one job, and the render-phase one is the unsafe half: React may render a
   * component without committing it (Strict Mode's double render, a suspended or discarded
   * concurrent render), so a ref written there can hold a value from a tree that never mounted.
   * An effect only runs on a COMMITTED render, which is exactly the guarantee a ref that
   * escapes into an async callback needs.
   *
   * ⚠ IT IS STILL LATE ENOUGH FOR EVERY READER. `authCallback` fires when ably-js opens or
   * REFRESHES a connection — always after mount, and typically 15 minutes later — so an effect
   * that runs on commit has updated the ref long before anything reads it.
   */
  useEffect(() => {
    onMessageRef.current = onMessage;
    onFileRef.current = onFile;
    onReactionRef.current = onReaction;
    fetchTokenRef.current = registration?.fetchToken;
  }, [onMessage, onFile, onReaction, registration?.fetchToken]);

  /**
   * ⚠⚠ THE EFFECT KEYS ON THE **CHANNEL NAMES** — TWO PLAIN STRINGS — AND ON NOTHING ELSE.
   *
   * `fetchToken` is held in a ref rather than being an effect dependency, and that is a
   * correctness decision rather than an optimisation. The shipped conversation hook makes it a
   * dependency and documents "the caller MUST memoise this"; a caller who forgets gets a full
   * teardown-and-resubscribe of every channel on EVERY RENDER, which presents as FLAPPING
   * CONNECTIVITY rather than as a bug and would be found in production. Reading it from a ref
   * removes the footgun entirely, and it is also strictly more correct: ably-js invokes
   * `authCallback` LATER, on expiry, so the ref hands it the CURRENT function rather than the
   * one captured when the connection opened.
   *
   * ⚠ THE CHANNELS ARE THE ONLY THING THAT SHOULD EVER FORCE A RECONNECT — they are what the
   * token's capability list is built from.
   */
  const meetingChannel = registration?.meetingChannel ?? null;
  const conversationChannel = registration?.conversationChannel ?? null;

  useEffect(() => {
    if (meetingChannel === null) {
      setStatus('disabled');
      return;
    }

    let disposed = false;
    let client: Ably.Realtime | null = null;
    /**
     * ⚠ HAS THIS CONNECTION EVER BEEN UP? It is what separates `'connecting'` (first attempt)
     * from `'reconnecting'` (a drop) — see {@link MeetingRealtimeStatus}. Local to the effect
     * rather than a ref, deliberately: a NEW client (the channels changed) is a first connect
     * again, and a fresh local is exactly that semantics with nothing to reset.
     */
    let hasConnected = false;
    setStatus('connecting');

    const connect = async (): Promise<void> => {
      const AblySdk = await import('ably');
      if (disposed) return;

      client = new AblySdk.Realtime({
        // ⚠ NODE-CALLBACK STYLE — a promise-returning `authCallback` silently fails.
        // ⚠ READ FROM THE REF AT CALL TIME, so a refresh 15 minutes from now uses the current
        // action rather than one captured when the connection opened.
        authCallback: (_tokenParams, callback) => {
          const fetchToken = fetchTokenRef.current;
          if (fetchToken === undefined) {
            callback('Realtime disabled', null);
            return;
          }
          fetchRealtimeToken(fetchToken, callback);
        },
      });

      client.connection.on('connected', () => {
        hasConnected = true;
        if (!disposed) setStatus('connected');
      });
      client.connection.on('failed', () => {
        if (!disposed) setStatus('failed');
      });
      // ⚠ THE COPY DIFFERS BY WHETHER WE EVER GOT UP. A drop before the first `connected` is
      // still the FIRST connect, not a reconnection.
      const onDrop = (): void => {
        if (!disposed) setStatus(hasConnected ? 'reconnecting' : 'connecting');
      };
      client.connection.on('disconnected', onDrop);
      client.connection.on('suspended', onDrop);

      // ⚠ NO `params` — see the module docblock's `rewind` prohibition.
      const meeting = client.channels.get(meetingChannel);
      meeting
        .subscribe(MEETING_EVENT_REACTION, (msg: Ably.InboundMessage) => {
          if (!disposed && isMeetingReactionPayload(msg.data)) onReactionRef.current(msg.data);
        })
        .catch(() => {
          // Attach failures surface via the connection-state listeners.
        });
      meeting
        .subscribe(MEETING_EVENT_FILE, (msg: Ably.InboundMessage) => {
          if (!disposed && isMeetingFilePayload(msg.data)) onFileRef.current(msg.data);
        })
        .catch(() => {
          // Attach failures surface via the connection-state listeners.
        });

      if (conversationChannel !== null) {
        client.channels
          .get(conversationChannel)
          .subscribe(CONVERSATION_EVENT_MESSAGE, (msg: Ably.InboundMessage) => {
            if (!disposed && isConversationMessagePayload(msg.data)) {
              onMessageRef.current({
                ...msg.data,
                // ⚠ DEFENCE IN DEPTH BEFORE `dangerouslySetInnerHTML`. See the docblock.
                bodyHtml: sanitizeRealtimeBodyHtml(msg.data.bodyHtml),
              });
            }
          })
          .catch(() => {
            // Attach failures surface via the connection-state listeners.
          });
      }
    };

    connect().catch(() => {
      if (!disposed) setStatus('failed');
    });

    return () => {
      disposed = true;
      client?.close();
      client = null;
    };
  }, [meetingChannel, conversationChannel]);

  return { status };
}

/** One floating emoji on the stage. ⚠ `nonce` IS THE REACT KEY — never an array index. */
export interface ReactionFloater {
  readonly nonce: string;
  readonly emoji: MeetingReactionEmoji;
}

/** How long a floater lives before the layer drops it. Matches the rise animation. */
export const REACTION_FLOAT_MS = 2_200;
/** How long an own-nonce is remembered, so the server's echo can be dropped. */
const OWN_NONCE_TTL_MS = 10_000;
/**
 * ⚠ A CAP, so a burst cannot grow the DOM without bound during a long call.
 *
 * ⚠ EXPORTED FOR ITS TEST. A cap asserted against a hard-coded `12` in the test file is two
 * numbers that can disagree, and the one that would go stale is the assertion.
 */
export const MAX_FLOATERS = 12;
/** Newest-last, capped. Chat arriving while the panel is closed is buffered here. */
const MAX_CHAT_FEED = 200;
/** ⚠ IT BOUNDS THE NETWORK CALL, NOT THE FLOAT. See `sendReaction` for the full trade-off. */
const REACTION_SEND_COOLDOWN_MS = 600;

/**
 * ⚠ THE REFUSAL COPY. Both say what happened in one sentence and neither blames the person.
 *
 * ⚠⚠ THE SIGNED-OUT LINE NAMES THE **CONSEQUENCE BEYOND REACTIONS**, on purpose. A dropped
 * reaction is disposable; a dropped session is not, and the very next thing they type would be
 * lost the same way. This is the cheapest possible place to find that out.
 */
const REACTION_FAILED_LINE = 'That reaction did not reach the call.';
const REACTION_SIGNED_OUT_LINE =
  'Your session ended, so that reaction did not reach the call. Reload this page before you send anything else.';

/** ⚠ THE ACTION'S OWN LITERAL, matched exactly — see `call-action-entry.ts`. */
const NOT_SIGNED_IN_ERROR = 'You are not signed in.';

export interface MeetingCallRealtime {
  readonly status: MeetingRealtimeStatus;
  /**
   * Inbound messages received for the life of this frame, append-only and capped.
   *
   * ⚠ THE FRAME HOLDS IT, NOT THE PANEL, because a message can arrive while the panel is
   * UNMOUNTED. The panel merges this by id on mount and on change, so nothing is lost and
   * nothing triggers a refetch storm.
   */
  readonly chatFeed: readonly ConversationMessageView[];
  /** Inbound `meeting_files` rows, same buffering rule as {@link chatFeed}. */
  readonly fileFeed: readonly MeetingFileView[];
  /** Bumped on every inbound file. The Files panel reloads on a change. */
  readonly fileRevision: number;
  readonly floaters: readonly ReactionFloater[];
  /**
   * ⚠ TRUE ONLY WHILE THE CHAT PANEL IS CLOSED. A dot, never a count.
   *
   * ⚠ THERE IS NO `clearUnreadChat`. An earlier version exposed one and NOTHING EVER CALLED IT
   * — the `isChatOpen` effect below is what clears the dot, which is the correct owner: the dot
   * is a function of "did a message arrive while the panel was shut", so a manual clear would be
   * a second way to answer a question that already has one.
   */
  readonly unreadChat: boolean;
  /** Optimistic float + fire-and-forget send. Reports the outcome to the frame. */
  readonly sendReaction: (emoji: MeetingReactionEmoji) => void;
}

/**
 * The frame-level state on top of the transport.
 *
 * ⚠ A SECOND HOOK RATHER THAN MORE STATE IN `MeetingFrameInner`, ONLY TO SHED COGNITIVE
 * COMPLEXITY. That component body is already at SonarCloud's ceiling of 15 and the repo's
 * precedent is to EXTRACT, never to disable the rule.
 */
export function useMeetingCallRealtime(input: {
  readonly registration: MeetingRealtimeRegistration | null;
  /** Whether the Chat slot is currently the open panel — drives the unread dot. */
  readonly isChatOpen: boolean;
  readonly onReactionSent: (emoji: MeetingReactionEmoji, outcome: 'ok' | 'failed') => void;
  /**
   * ⚠⚠ HOW A **FAILED** REACTION REACHES THE PERSON WHO SENT IT. Analytics is not a user
   * interface: `onReactionSent` feeds PostHog, this feeds the toast and the frame's §16 live
   * region. Without it a mid-call session expiry is completely silent to the sender — their
   * optimistic float rose over the stage exactly as it does on success, so they believe the
   * room saw it. See {@link REACTION_FAILED_LINE}.
   */
  readonly onReactionError: (message: string) => void;
}): MeetingCallRealtime {
  const { registration, isChatOpen, onReactionSent, onReactionError } = input;

  const [chatFeed, setChatFeed] = useState<readonly ConversationMessageView[]>([]);
  const [fileFeed, setFileFeed] = useState<readonly MeetingFileView[]>([]);
  const [fileRevision, setFileRevision] = useState(0);
  const [floaters, setFloaters] = useState<readonly ReactionFloater[]>([]);
  const [unreadChat, setUnreadChat] = useState(false);

  /** Nonces this client minted, pruned after {@link OWN_NONCE_TTL_MS}. */
  const ownNoncesRef = useRef<Set<string>>(new Set());
  /** ⚠ THE COOLDOWN IS A UX AFFORDANCE, NOT A THROTTLE. BAL-461 owns the real one. */
  const lastSentAtRef = useRef(0);
  /** Read inside the message handler without making the handler a resubscribe trigger. */
  const isChatOpenRef = useRef(isChatOpen);
  useEffect(() => {
    isChatOpenRef.current = isChatOpen;
    if (isChatOpen) setUnreadChat(false);
  }, [isChatOpen]);

  const dropFloater = useCallback((nonce: string): void => {
    setFloaters((current) => current.filter((item) => item.nonce !== nonce));
  }, []);

  const pushFloater = useCallback(
    (floater: ReactionFloater): void => {
      setFloaters((current) => [...current, floater].slice(-MAX_FLOATERS));
      setTimeout(() => dropFloater(floater.nonce), REACTION_FLOAT_MS);
    },
    [dropFloater]
  );

  const onMessage = useCallback((message: ConversationMessageView): void => {
    setChatFeed((current) =>
      current.some((item) => item.id === message.id)
        ? current
        : [...current, message].slice(-MAX_CHAT_FEED)
    );
    // ⚠ NOT ANNOUNCED THROUGH THE §16 LIVE REGION. A per-message announcement during a live
    // call is noise, and that region is for mutation OUTCOMES.
    if (!isChatOpenRef.current) setUnreadChat(true);
  }, []);

  const onFile = useCallback((file: MeetingFileView): void => {
    setFileFeed((current) =>
      current.some((item) => item.id === file.id) ? current : [...current, file]
    );
    setFileRevision((current) => current + 1);
  }, []);

  const onReaction = useCallback(
    (reaction: MeetingReactionPayload): void => {
      // ⚠⚠ DROP OUR OWN ECHO. The server publishes, so the sender receives their own reaction
      // back and would double-float it on top of the optimistic render.
      if (ownNoncesRef.current.has(reaction.nonce)) return;
      pushFloater({ nonce: reaction.nonce, emoji: reaction.emoji });
    },
    [pushFloater]
  );

  const { status } = useMeetingRealtime({ registration, onMessage, onFile, onReaction });

  /**
   * ⚠⚠ THE FAILURE PATH: UNDO THE OPTIMISTIC FLOAT, THEN SAY SO.
   *
   * The float has ALREADY risen over the stage by the time this runs — that is the whole point
   * of the optimistic render — so leaving it up after a refusal tells the sender the room saw
   * something the room never received. Removing it by `nonce` and reporting one sentence is the
   * smallest honest correction: the glyph disappears, and the person is told why.
   *
   * ⚠ THE NOT-SIGNED-IN CASE IS SURFACED SEPARATELY, and that is not pedantry. A reaction is
   * disposable; a mid-call SESSION EXPIRY is not, because their next chat message will fail the
   * same way and their file upload will too. Telling them "reload this page" once, on the
   * cheapest failure, is what stops them discovering it on a sentence they cared about.
   */
  const reportFailedReaction = useCallback(
    (nonce: string, error: string | undefined): void => {
      dropFloater(nonce);
      onReactionError(
        error === NOT_SIGNED_IN_ERROR ? REACTION_SIGNED_OUT_LINE : REACTION_FAILED_LINE
      );
    },
    [dropFloater, onReactionError]
  );

  const sendReaction = useCallback(
    (emoji: MeetingReactionEmoji): void => {
      if (registration === null) return;

      const nonce = globalThis.crypto.randomUUID();
      ownNoncesRef.current.add(nonce);
      setTimeout(() => ownNoncesRef.current.delete(nonce), OWN_NONCE_TTL_MS);

      // ⚠⚠ THE FLOAT NEVER WAITS ON THE NETWORK, AND IT IS NOW ALSO NEVER SWALLOWED BY THE
      // COOLDOWN. Previously the cooldown returned BEFORE this line, so a second tap inside
      // 600ms produced no float, no toast and no analytics event — i.e. a control that silently
      // did nothing, which reads as a broken button rather than as a rate limit.
      pushFloater({ nonce, emoji });

      /**
       * ⚠⚠ THE 600ms COOLDOWN NOW BOUNDS THE **NETWORK CALL ONLY**, and the trade-off is
       * written down rather than discovered: a second tap inside the window floats on the
       * SENDER'S OWN STAGE and is not broadcast. Two taps 600ms apart are one gesture, so
       * coalescing the fan-out is deliberate — but it does mean the sender briefly sees one
       * more glyph than the room does. That is the lesser of the two dishonesties (the other
       * being a control that appears dead), and it is bounded to the sender's own screen for
       * 2.2s. ⚠⚠ IT IS STILL NOT A THROTTLE — `send-meeting-reaction.ts` states the missing
       * server-side limit and names **BAL-461**.
       */
      const now = Date.now();
      if (now - lastSentAtRef.current < REACTION_SEND_COOLDOWN_MS) return;
      lastSentAtRef.current = now;

      registration
        .sendReaction({ emoji, nonce })
        .then((result) => {
          onReactionSent(emoji, result.success ? 'ok' : 'failed');
          if (!result.success) reportFailedReaction(nonce, result.error);
        })
        .catch(() => {
          onReactionSent(emoji, 'failed');
          reportFailedReaction(nonce, undefined);
        });
    },
    [registration, pushFloater, onReactionSent, reportFailedReaction]
  );

  return useMemo(
    () => ({ status, chatFeed, fileFeed, fileRevision, floaters, unreadChat, sendReaction }),
    [status, chatFeed, fileFeed, fileRevision, floaters, unreadChat, sendReaction]
  );
}
