'use client';

import { Loader2 } from 'lucide-react';

/**
 * BAL-132 (Decision 12 / Addendum A2) — **THE SEAM BETWEEN A CREDENTIAL AND A CALL.**
 *
 * ⚠⚠ BAL-132 SHIPS A CREDENTIAL, NOT A CALL, AND THIS COMPONENT IS WHERE THAT LINE IS DRAWN.
 * `@daily-co/daily-js` is **NOT** a dependency of any package in this PR, deliberately:
 * D1 assigns `DailyProvider`, the PreJoin screen, the video stage and the toolbar to
 * **BAL-435**. So this renders "Connecting…" and holds the props BAL-435 will consume.
 *
 * ⚠ IT IS NOT A PLACEHOLDER TO BE DELETED. It is the PROP CONTRACT, fixed now so BAL-435
 * builds against a stated shape rather than re-deriving one from this PR's diff. **That
 * contract — `roomUrl`, `token`, `isOwner`, `expiresAt`, `participantId` and their types — is
 * written into BAL-435's Linear description at hand-off** (Addendum A2.3). Changing a prop
 * here without changing it there is the drift this file exists to prevent.
 *
 * ── ⚠ WHAT BAL-435 MUST KNOW ABOUT THESE PROPS ──────────────────────────────────────────
 *
 *   · `token` IS A LIVE CREDENTIAL to a `privacy: 'private'` room. Never log it, never put it
 *     in an analytics property, never render it as copyable text, and never place it in a URL.
 *     It is the ONLY thing that admits anyone: the room URL alone admits nobody.
 *   · `isOwner` IS ALREADY DECIDED, SERVER-SIDE, per actor, from
 *     `hasEngagementCapability(HOST_MEETINGS)`. ⚠ Gate host controls (admit/deny, end call,
 *     mute) on THIS BOOLEAN — never on `activeMode`, a lens, or a role string. That comparison
 *     is what ADR-1029 forbids and what the in-meeting design prototype does; take the
 *     prototype's layout, not its gate.
 *   · `participantId` IS THE DECISION-1 ENCODING (`u`/`g` + 32 hex), not a bare uuid. Pass it
 *     to Daily verbatim; BAL-131's webhook and BAL-134's presence writer decode it to route
 *     between `meeting_presence.user_id` and `meeting_guest_id`.
 *   · `expiresAt` IS SCHEDULED END + 24h, and `eject_at_token_exp` is FALSE — so a token
 *     expiring mid-call does NOT eject anyone. It only prevents a fresh join. Do not build a
 *     countdown that ends the call.
 *   · `headingRef` IS THE FOCUS TARGET, and it is part of the contract for the reason below.
 *
 * ⚠ WHEN BAL-435 MOUNTS THE REAL SDK, IT MUST BE A DYNAMIC IMPORT. `@daily-co/daily-js` is a
 * heavy vendor bundle and CLAUDE.md's performance rules name it explicitly: it must not land
 * in the initial bundle.
 */
export interface MeetingCallSurfaceProps {
  /** The Daily room URL. ⚠ Admits nobody on its own — the room is private. */
  readonly roomUrl: string;
  /** ⚠ THE DAILY JWT. Never log, persist, or render this. */
  readonly token: string;
  /** The server's `host_meetings` verdict. ⚠ Gate host controls on THIS, never on a lens. */
  readonly isOwner: boolean;
  /** ISO 8601 — scheduled end + 24h. ⚠ Expiry does NOT eject; see the docblock. */
  readonly expiresAt: string;
  /** The Decision-1 encoding: `u`/`g` + 32 hex. Never a bare uuid. */
  readonly participantId: string;
  /**
   * ⚠⚠ THE FOCUS TARGET FOR THE **ADMITTED** TRANSITION — the one that matters most, and the
   * one that moved focus NOWHERE until this prop existed.
   *
   * Both join surfaces replace the entire card on every state change, which drops focus to
   * `<body>`: a keyboard or screen-reader user is silently returned to the top of the document
   * with no signal that anything happened. `JoinNoticeCard` (every failure state) and both
   * waiting cards already accept this; the ADMITTED state — "you're in" — did not, so the one
   * transition a guest actually waited for was the one that announced nothing.
   *
   * ⚠ IT IS ADDED **NOW**, NOT BY BAL-435, because this file's stated purpose is to freeze the
   * prop contract before that ticket starts. A prop added later is a contract change; a prop
   * added here is the contract. BAL-435 attaches it to whatever its real stage renders as the
   * primary heading and gets the behaviour for free.
   *
   * ⚠ THE OWNER FOCUSES IT; this component only forwards it. `tabIndex={-1}` on the heading is
   * what makes a non-interactive element focusable programmatically without joining the tab
   * order — do not "tidy" it away.
   */
  readonly headingRef?: React.Ref<HTMLHeadingElement>;
}

/**
 * ⚠ TYPED AS A `const` WITH AN EXPLICIT COMPONENT TYPE, AND THE IMPLEMENTATION DESTRUCTURES
 * ONLY `headingRef`. That combination is the point, not a stylistic quirk:
 *
 *   · THE PROP CONTRACT IS STILL FULLY ENFORCED AT EVERY CALL SITE. A caller that omits
 *     `token`, or passes `isOwner` as a string, is a compile error — which is the whole
 *     deliverable of this seam.
 *   · YET THERE IS NO UNUSED PARAMETER. This build renders a fixed state, so naming the five
 *     credential props only to ignore them trips `@typescript-eslint/no-unused-vars`, and
 *     `apps/web` runs ESLint with `--max-warnings 0`. The two obvious workarounds are both
 *     worse: `void props` is SonarCloud S3735, and an `eslint-disable` would suppress a real
 *     warning class for every future edit to this file.
 *
 * ⚠ BAL-435 SIMPLY NAMES THE REST when it starts reading them — no signature change, no
 * call-site change.
 *
 * ⚠ AND THE PARAMETER CARRIES ITS TYPE INLINE AS WELL AS VIA THE ALIAS. That looks redundant
 * and is not: `eslint-plugin-react`'s `prop-types` rule reads the PARAMETER's annotation, not
 * the variable's, so with the alias alone it reports "'headingRef' is missing in props
 * validation" — a warning, and `apps/web` lints with `--max-warnings 0`.
 */
type MeetingCallSurfaceComponent = (props: Readonly<MeetingCallSurfaceProps>) => React.JSX.Element;

export const MeetingCallSurface: MeetingCallSurfaceComponent = ({
  headingRef,
}: Readonly<MeetingCallSurfaceProps>) => {
  return (
    /*
      ⚠⚠ **NO `aria-busy` ANYWHERE IN THIS SUBTREE, INCLUDING THE DECORATIVE SPAN.** It tells
      assistive tech to SUPPRESS announcements from the region it is on and, in several screen
      readers, from that region's descendants — and on a live region whose entire job is to say
      "you're in", that silences the one message the element exists to deliver.

      An earlier fix moved the attribute from the `<output>` onto the decorative `<span>` and
      the docblock above it announced "NO `aria-busy`" three lines before shipping
      `aria-busy="true"`. That is worse than either choice made honestly: the attribute was
      still inside the live region, it still never cleared, and its only child is already
      `aria-hidden`, so it described nothing to anyone. It is now GONE, and this paragraph is
      what stops it coming back "on the decorative element, where it's safe".

      ⚠ IF BAL-435 WANTS A GENUINE BUSY SIGNAL it must be on an element OUTSIDE this `<output>`
      and it must CLEAR when the call connects. A hardcoded literal is not a busy signal.
    */
    <output className="border-border bg-card mx-auto flex w-full max-w-md flex-col items-center rounded-2xl border p-8 text-center shadow-sm">
      <span className="border-border bg-muted/40 flex h-12 w-12 items-center justify-center rounded-2xl border">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" aria-hidden="true" />
      </span>
      {/* ⚠ `tabIndex={-1}` — programmatically focusable, never in the tab order. See the prop. */}
      <h1 ref={headingRef} tabIndex={-1} className="text-foreground mt-4 text-lg font-semibold">
        Connecting…
      </h1>
      <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">
        You&apos;re in. We&apos;re setting up your call room now.
      </p>
    </output>
  );
};
