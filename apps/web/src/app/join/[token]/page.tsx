import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { CalendarClock, Users, UserPlus, Video } from 'lucide-react';
import {
  agenciesRepository,
  companiesRepository,
  engagementsRepository,
  expertsRepository,
  meetingContextsRepository,
  meetingGuestsRepository,
  usersRepository,
} from '@balo/db';
import {
  MEETING_CONTEXT_PRECEDENCE,
  selectPrimaryMeetingContext,
  type GuestAccessScopeLabel,
  type MeetingContextTypeLabel,
  type SelectPrimaryMeetingContextResult,
} from '@balo/shared/meetings';
import {
  expertPartyDisplayName,
  personDisplayName,
  personWithOrgLabel,
} from '@balo/shared/parties';
import { checkMemoryLimit } from '@/lib/rate-limit/memory-window';
import { clientIp } from '@/lib/magic-link';
import { formatUtcLongDate, formatUtcLongDateWithWeekday } from '@/lib/format/local-date';
import { resolveMeetingGuestSubject } from '@/lib/meetings/resolve-meeting-guest';
import { conversationSubjectForMeetingContext } from '@balo/shared/conversations';
import { log } from '@/lib/logging';
import { trackServerAndFlush, GUEST_SERVER_EVENTS } from '@/lib/analytics/server';
import { LinkNotActive } from './link-not-active';
import { JoinControl } from './join-control';
import { AccessScopeDisclosure } from './_components/access-scope-disclosure';

// `node:crypto` (token hashing) + Drizzle need Node, not Edge.
export const runtime = 'nodejs';
// Per-token, access-stamping content — never statically cached.
export const dynamic = 'force-dynamic';

// Public magic-link page — deliberately NOT indexed, and a NEUTRAL title: the tab and any
// share preview must not name the company, the agency, the expert or the meeting.
export const metadata: Metadata = {
  title: 'Your invitation — Balo',
  robots: { index: false, follow: false },
};

interface JoinLandingPageProps {
  /** ⚠ Next 16: this is a Promise and MUST be awaited. */
  params: Promise<{ token: string }>;
}

/**
 * Human labels for the primary `meeting_contexts.context_type`.
 *
 * TOTAL BY CONSTRUCTION (`Record<MeetingContextTypeLabel, string>`): an eighth context type
 * added to the pgEnum fails `pnpm typecheck` here until it is given a guest-facing name,
 * rather than silently rendering the generic fallback.
 *
 * ⚠ `admin` IS UNREACHABLE THROUGH THIS MAP and is listed anyway. `selectPrimaryMeetingContext`
 * scores it 0 and DROPS it, so an admin-only meeting resolves to `{ ok: false, reason: 'none' }`
 * and lands on {@link GENERIC_CONTEXT_LABEL}. Listing it keeps the record total; deleting it
 * would make the type non-exhaustive and hide the next enum addition.
 */
const CONTEXT_LABELS: Record<MeetingContextTypeLabel, string> = {
  case: 'Consultation',
  project_kickoff: 'Project kickoff',
  package_session: 'Package session',
  retainer_checkin: 'Check-in',
  request_interaction: 'Intro call',
  project_discovery: 'Discovery call',
  admin: 'Meeting',
};

/** What an unresolvable / ambiguous / admin-only context is called. Names nothing. */
const GENERIC_CONTEXT_LABEL = 'Meeting';

/**
 * The precedence tier at which a context names an `engagements.id` — DERIVED from the shared
 * map rather than hardcoded as `100`, so a re-tiering in `@balo/shared/meetings` cannot leave
 * this file silently reading the wrong grain.
 */
const ENGAGEMENT_GRAIN_SCORE = MEETING_CONTEXT_PRECEDENCE.case;

/** What a guest whose row carries no name is called — the literal `projectGuestForViewer` uses. */
const ANONYMOUS_GUEST_LABEL = 'Guest';

/** "14:00" in UTC — see {@link formatScheduledWindow} for why UTC. */
function formatUtcTimeOfDay(value: Date): string {
  const hours = String(value.getUTCHours()).padStart(2, '0');
  const minutes = String(value.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * "14:00 – 15:00 UTC" — the window, WITH ITS ZONE STATED, never a bare wall-clock time.
 *
 * ⚠ UTC IS A DELIBERATE CHOICE, NOT A SHORTCUT. A guest is by definition not a Balo user, so
 * there is no stored timezone to render in; the server's zone would be arbitrary, and reading
 * the browser's zone from an RSC means either a hydration mismatch or a client component this
 * page does not otherwise need. UTC is stable, identical on the server and on first paint, and
 * — crucially — LABELLED, so a reader in Sydney converts rather than silently misreading it.
 * (Same rationale as `formatUtcLongDate`'s: hand-rolled, never `Intl`, so it cannot drift by
 * shell locale.) **Hand-off: a viewer-local time swap belongs with BAL-132's join control,
 * which brings a client component to this route anyway.**
 */
function formatScheduledWindow(start: Date, end: Date): string {
  return `${formatUtcTimeOfDay(start)} – ${formatUtcTimeOfDay(end)} UTC`;
}

/** The two party labels on the engagement behind this meeting, when there is one. */
interface EngagementParties {
  /** The client company's name. */
  readonly clientCompanyName: string | null;
  /** BAL-329's party-vs-person label for the DELIVERING expert (agency name, else person). */
  readonly expertPartyLabel: string | null;
}

const NO_PARTIES: EngagementParties = { clientCompanyName: null, expertPartyLabel: null };

/**
 * The delivering expert's party label. Agency-based → the agency's name; freelancer (or an
 * agency with a blank name) → the person's name — `expertPartyDisplayName`'s BAL-329 rule,
 * imported rather than re-derived.
 *
 * ⚠ `findNamesByIds` IS THE ONLY USER READ ON THIS PAGE, and that is deliberate: it projects
 * `first_name`/`last_name` ONLY. `usersRepository.findById` / `findWithCompany` hydrate the
 * FULL row — `workosId`, `email`, phone — into an RSC serving an unauthenticated external
 * visitor (memory `reference_drizzle_with_hydration_leaks_secrets`). Do not swap it.
 */
async function resolveExpertPartyLabel(profile: {
  type: 'freelancer' | 'agency';
  agencyId: string | null;
  userId: string;
}): Promise<string> {
  const agency =
    profile.agencyId === null
      ? undefined
      : await agenciesRepository.getSummaryById(profile.agencyId);
  const [person] = await usersRepository.findNamesByIds([profile.userId]);
  return expertPartyDisplayName({
    type: profile.type,
    agencyName: agency?.name ?? null,
    firstName: person?.firstName ?? null,
    lastName: person?.lastName ?? null,
  });
}

/**
 * Resolve the two party labels from the meeting's PRIMARY context.
 *
 * ⚠ ONLY THE ENGAGEMENT GRAIN CARRIES THEM. A `request_interaction` / `project_discovery`
 * context names a `project_requests.id` or a `request_expert_relationships.id`, not an
 * engagement, so there is no `company_id` / `expert_profile_id` to read — and an `admin` or
 * AMBIGUOUS context resolves to no primary at all. In every one of those cases this returns
 * {@link NO_PARTIES} and the page renders WITHOUT the affiliation lines.
 *
 * ⚠⚠ THAT IS A DEGRADE, NEVER A BAIL-OUT. The token already resolved LIVE against a live
 * meeting; refusing to render because an unrelated read came back thin would show a legitimate
 * guest the "link isn't active" card — an outright lie, and one they cannot recover from
 * because they have no account to sign into. Attribution copy that cannot name an org drops
 * the "@ org" clause and shows the bare name, exactly as `engagementActorAttribution` does for
 * a freelancer expert. It NEVER invents one.
 */
async function resolveEngagementParties(
  primary: SelectPrimaryMeetingContextResult
): Promise<EngagementParties> {
  if (!primary.ok) {
    return NO_PARTIES;
  }
  if (MEETING_CONTEXT_PRECEDENCE[primary.context.contextType] !== ENGAGEMENT_GRAIN_SCORE) {
    return NO_PARTIES;
  }

  const engagement = await engagementsRepository.findById(primary.context.contextId);
  if (engagement === undefined) {
    return NO_PARTIES;
  }

  const [company, profile] = await Promise.all([
    companiesRepository.findById(engagement.companyId),
    expertsRepository.findProfileById(engagement.expertProfileId),
  ]);

  return {
    clientCompanyName: company?.name ?? null,
    expertPartyLabel: profile === undefined ? null : await resolveExpertPartyLabel(profile),
  };
}

interface DetailRowProps {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}

/**
 * One label/value line in the invitation card. Presentation only.
 *
 * ⚠ `<dt>` / `<dd>`, NOT TWO LOOSE `<p>`s — the rows ARE a description list, and the parent
 * supplies the `<dl>`. Rendered as unassociated paragraphs, a screen-reader user heard four
 * label strings and four value strings with nothing tying them together, on a card whose
 * entire content is label/value pairs.
 *
 * ⚠ EXACTLY ONE `<div>` BETWEEN THE `<dl>` AND ITS `<dt>`/`<dd>`, WHICH IS WHY THIS IS A
 * GRID AND NOT THE OBVIOUS FLEX-ROW-PLUS-INNER-DIV. HTML permits a single grouping `<div>`
 * inside a `<dl>`; nesting a second one to hold the text column puts the `<dt>`/`<dd>` out
 * of their list (invalid markup, and axe's `dlitem`). The grid places the icon in column 1
 * spanning both rows, and the term/description in column 2 — same visual result, valid
 * structure. `2rem` is the icon's own `h-8 w-8`.
 *
 * The `hint` rides INSIDE the `<dd>` (a second line of the same value) rather than as its
 * own `<dd>`: "10:00 – 11:00 UTC" qualifies the date above it, it is not a separate term.
 */
function DetailRow({ icon, label, value, hint }: Readonly<DetailRowProps>): React.JSX.Element {
  return (
    <div className="grid grid-cols-[2rem_1fr] items-start gap-x-3">
      <span
        className="border-border bg-muted/40 text-muted-foreground col-start-1 row-span-2 row-start-1 mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg border"
        aria-hidden="true"
      >
        {icon}
      </span>
      <dt className="text-muted-foreground col-start-2 row-start-1 min-w-0 text-[11.5px] font-medium tracking-wide uppercase">
        {label}
      </dt>
      <dd className="text-foreground col-start-2 row-start-2 mt-0.5 min-w-0 text-[13.5px] leading-relaxed font-medium">
        {value}
        {hint !== undefined && (
          <span className="text-muted-foreground mt-0.5 block text-[12.5px] leading-relaxed font-normal">
            {hint}
          </span>
        )}
      </dd>
    </div>
  );
}

/**
 * The success view's PLAIN, ALREADY-RESOLVED props.
 *
 * ⚠ EVERY FIELD IS A PRIMITIVE, and no `@balo/db` row reaches this shape. That is not
 * cosmetic: a Drizzle row carried past the RSC boundary is how `token_hash`, `email` and
 * `workos_id` end up in a payload (memories `reference_drizzle_with_hydration_leaks_secrets`
 * and `reference_balo_db_client_bundle_footgun`). The RSC does every read and hands this down.
 */
interface InvitationViewProps {
  readonly contextLabel: string;
  readonly hasEnded: boolean;
  readonly isDelegate: boolean;
  readonly scheduledDate: string;
  readonly scheduledWindow: string;
  readonly inviterAttribution: string;
  readonly counterparty: string | null;
  /** NAMES ONLY — never an address. See the page docblock. */
  readonly otherGuestNames: readonly string[];
  readonly accessScope: GuestAccessScopeLabel;
  readonly expiresOn: string;
  /**
   * BAL-132 — everything {@link JoinControl} needs. ⚠ The raw token is passed through so the
   * control can POST it to the mint endpoint; it is NEVER rendered as text.
   */
  readonly token: string;
  readonly meetingId: string;
  readonly scheduledStartIso: string;
  readonly scheduledEndIso: string;
  /**
   * BAL-445 §7 — resolved server-side from the SAME primary context this page already
   * fetched, so the admitted guest mount can register a Chat slot (or not) without ever
   * flashing a button onto a conversation that does not exist.
   */
  readonly hasChat: boolean;
}

/**
 * The invitation card's CONTENT. ⚠ The card itself — and the join phase that can replace it —
 * belongs to {@link JoinControl}; see the note at this function's `return`.
 *
 * ⚠⚠ **THE JOIN BUTTON IS `JoinControl`'S, NOT THIS COMPONENT'S, AND THAT SPLIT IS A DECISION.**
 * BAL-129 provisions the Daily room with `privacy: 'private'`, so `meetings.join_url` is NOT a
 * working control for anyone without a meeting token — a raw link would render a dead button,
 * or worse, drop the guest into Daily's own knocking UI outside Balo's admit/deny flow. Minting
 * a token from an RSC would ALSO mean minting it for whoever is holding the link (including a
 * link scanner), which is precisely the decision the lobby exists to make. So the mint is a
 * POST-only, user-initiated Server Action behind a client boundary, and this RSC renders only
 * what it can prove.
 *
 * ⚠ NO BILLING, RATE OR PRICE LINE ANYWHERE. Guests do not change what anybody pays (billing
 * is per-minute of EXPERT time, never per-seat), and a guest is the last audience that should
 * learn what anybody pays.
 *
 * DRAFT COPY — pending MJ sign-off. Gender-neutral throughout: the guest is "you", everyone
 * else is named or referred to by party.
 */
function InvitationView({
  contextLabel,
  hasEnded,
  isDelegate,
  scheduledDate,
  scheduledWindow,
  inviterAttribution,
  counterparty,
  otherGuestNames,
  accessScope,
  expiresOn,
  token,
  meetingId,
  scheduledStartIso,
  scheduledEndIso,
  hasChat,
}: Readonly<InvitationViewProps>): React.JSX.Element {
  const headline = hasEnded ? 'This call has already taken place' : "You're invited";
  const roleLine = isDelegate
    ? 'You’ve been asked to attend in place of the person who booked this call.'
    : 'You’ve been added to this call as a guest.';
  const whenLabel = hasEnded ? 'It was held' : 'When';
  const withLabel = hasEnded ? 'It was with' : "You'll be meeting";

  /**
   * ⚠⚠ THIS ROW IS OMITTED WHEN IT IS EMPTY, AND IT IS LABELLED "Other guests", NOT
   * "Others invited". Both halves are corrections of a copy bug that stated something FALSE.
   *
   * `otherGuestNames` comes from `listLiveByMeeting`, and `meeting_guests` holds NON-USER
   * guests ONLY — the booker and the delivering expert are structurally absent from it (the
   * service says so in as many words: "the schema has no authenticated-participant
   * roster"). So the previous "Others invited: Just you" told the FIRST guest on any call
   * that they were alone on a call with at least two other people — and contradicted the
   * "You'll be meeting: {org}" row rendered two lines above it.
   *
   * Rather than invent a roster the database cannot answer, the row now claims only what it
   * can prove: the OTHER GUESTS. When there are none it says nothing at all, which is the
   * honest rendering of "we have nothing to add here" — and it is not an actionable empty
   * state, so CLAUDE.md's keep-it-with-invitation-copy rule does not apply (a guest cannot
   * invite anybody).
   */
  const hasOtherGuests = otherGuestNames.length > 0;

  /**
   * ⚠ THE ONLY SENTENCE THAT TELLS THE GUEST WHAT HAPPENS NEXT. Without it the page never
   * says it is a VIDEO call, never says they join from this same page, and never says to
   * come back at the start time — the only venue signal was an `aria-hidden` icon. There is
   * still deliberately NO JOIN BUTTON (see this component's docblock; BAL-132 owns it), so
   * this line has to carry the whole expectation.
   *
   * The `hasEnded` branch replaces "keep this link" with a REASON to keep it, which the
   * closing line otherwise asserts without one.
   */
  const nextStepLine = hasEnded
    ? 'Nothing more to do — the recap will appear on this page once it’s ready.'
    : 'Come back to this page when it’s time — you’ll join the video call from here.';

  /*
    ⚠⚠ BAL-132 — `JoinControl` OWNS THE `<article>` CARD; THIS RSC SUPPLIES ITS CONTENT.
    The join phase is a CLIENT concern and, once the guest is admitted, the call surface must
    REPLACE this card rather than render inside it — which is what nesting produced: two `<h1>`s
    on the page, "You're in" immediately above "Come back to this page when it's time", and a
    560px column handed to BAL-435 to build a video stage in. Inverting the wrapper costs two
    props (`nextStepLine`, `expiresOn`) and removes all three.
  */
  return (
    <JoinControl
      token={token}
      meetingId={meetingId}
      scheduledStartIso={scheduledStartIso}
      scheduledEndIso={scheduledEndIso}
      utcWindowLabel={scheduledWindow}
      hasEnded={hasEnded}
      hasChat={hasChat}
      nextStepLine={nextStepLine}
      expiresOn={expiresOn}
    >
      <span className="border-border bg-muted/40 text-muted-foreground inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium">
        <Video className="h-3 w-3" aria-hidden="true" />
        {contextLabel}
      </span>

      <h1 className="text-foreground mt-4 text-xl font-semibold tracking-tight">{headline}</h1>
      <p className="text-muted-foreground mt-2 text-[13.5px] leading-relaxed">{roleLine}</p>

      <dl className="border-border mt-6 space-y-4 border-t pt-5">
        <DetailRow
          icon={<CalendarClock className="h-4 w-4" />}
          label={whenLabel}
          value={scheduledDate}
          hint={scheduledWindow}
        />

        <DetailRow
          icon={<UserPlus className="h-4 w-4" />}
          label="Invited by"
          value={inviterAttribution}
        />

        {counterparty !== null && (
          <DetailRow icon={<Users className="h-4 w-4" />} label={withLabel} value={counterparty} />
        )}

        {hasOtherGuests && (
          <DetailRow
            icon={<Users className="h-4 w-4" />}
            label="Other guests"
            value={otherGuestNames.join(', ')}
          />
        )}
      </dl>

      <AccessScopeDisclosure accessScope={accessScope} />
    </JoinControl>
  );
}

/**
 * ⚠⚠ THE PROPERTY AND THE ACCEPTANCE CRITERION OF THIS FILE: **ONE IDENTICAL CARD FOR EVERY
 * WAY THIS CAN FAIL, AND NOT ONE BYTE OF DIFFERENCE BETWEEN THEM.**
 *
 * `meetingGuestsRepository.findLiveByTokenHash` returns `undefined` IDENTICALLY for a WRONG,
 * EXPIRED, REVOKED, SOFT-DELETED or DENIED token AND for a token whose meeting is CANCELLED or
 * soft-deleted. This page adds the rate-limit bail-out and the corrupt-`party` guard, and
 * renders the SAME propless {@link LinkNotActive} for all of them. Differentiating any one
 * would make the response an oracle — "this token was real once", "that meeting exists but was
 * cancelled", "you were removed" — against a URL that is, by design, presented repeatedly and
 * from several devices. `page.test.tsx` renders every outcome and asserts
 * `new Set(markup).size === 1`.
 *
 * ⚠ AN `ended` MEETING STILL RESOLVES, deliberately, and this page therefore RENDERS for one —
 * with a past-tense framing instead of a pre-call one. The asymmetry with the MUTATION gate
 * (which refuses `ended`) is intentional: an ended meeting's link is the guest's only handle on
 * the recap BAL-388 will attach to it, whereas inviting someone to a call that already happened
 * is meaningless. Pinned by a test — do not "tidy" it into agreeing with the mutation gate.
 *
 * ⚠ NO GUEST SESSION COOKIE IS MINTED. Neither shipped token landing mints one, and this one
 * must not either: the token IS the credential, it is re-presented on every visit, and a cookie
 * would survive revocation until it expired — turning "removing a guest is immediate and total"
 * into a lie.
 *
 * ⚠ NO `<Link>` ANYWHERE IN THE APP MAY POINT AT `/join/...` — Next prefetches those on
 * viewport/hover, which would stamp accesses on links nobody opened.
 *
 * Order of operations, every step load-bearing:
 *   1.   await `params` (Next 16 — a sync interface silently no-ops).
 *   2.   Rate-limit FIRST, before any hashing or DB read. That is what makes step 4 affordable
 *        under a scanner storm.
 *   3–4. Hash the presented token, resolve it LIVE-only, then re-compare in constant time.
 *   5.   Narrow `party` to a side, failing CLOSED on a corrupt row.
 *   6.   Context → the D3 precedence winner → a human label; then the party labels. ⚠ NONE of
 *        these DEGRADE INTO A BAIL-OUT (see `resolveEngagementParties`).
 *   7.   The roster and the inviter's name — names only, never an address.
 *   8.   `recordAccess` — AFTER every bail-out, so a scanner hitting a revoked link records
 *        nothing and a data anomaly cannot inflate the count. `first_open` is computed BEFORE
 *        the stamp (pre-increment) and the emit below always pairs with it.
 *   9.   `GUEST_INVITE_OPENED` — SUCCESS ONLY, `distinct_id` = the GUEST row's id (a guest has
 *        no user id).
 *
 * ⚠ UNLIKE `/review/{token}`, THIS PAGE DOES EMIT ON GET, and the difference is reasoned, not
 * accidental. The review landing stays silent because Gmail's proxy and Safe Links detonation
 * fetch an emailed URL unsolicited and would corrupt a conversion funnel that has no DB-side
 * cap. `guest_invite_opened` is not a funnel step: it is the LIVENESS signal for a link, keyed
 * to the guest row, and `first_open` is derived from the same scanner-inflated `access_count`
 * the stamp bumps — so the event and the column tell the same (coarse) story rather than
 * contradicting each other. The `/shared/proposals/{token}` landing already emits on the same
 * reasoning. **It is still NOT "human opens" — do not build a conversion metric on it.**
 *
 * ⚠ **NO EMAIL ADDRESS OF ANY PERSON IS RENDERED, INCLUDING SAME-PARTY ONES — WHICH IS
 * STRICTER THAN `projectGuestForViewer`, ON PURPOSE.** That helper's same-party branch returns
 * the address, and falls `displayName` back to it, because its audience is a party MEMBER who
 * can already see the roster. THIS page's reader is an external person who happens to hold a
 * link. So every other participant renders as `name ?? 'Guest'` — the cross-party rule, applied
 * to everybody.
 *
 * ⚠ AND THE RAW TOKEN IS NEVER RENDERED AS COPYABLE TEXT. It is in the URL because it has to
 * be; putting it in the body as well would invite a screenshot into a group chat.
 */
export default async function JoinLandingPage({
  params,
}: Readonly<JoinLandingPageProps>): Promise<React.JSX.Element> {
  const { token } = await params;
  const headerList = await headers();

  // Defense-in-depth throttle. The real control is the ≥256-bit token; on limit we render the
  // same leak-free card (never a 429, never a throttle detail).
  if (!checkMemoryLimit(`join-landing:${clientIp(headerList)}`)) {
    return <LinkNotActive />;
  }

  // BAL-445 — the extracted per-request subject resolver. `null` for every failure shape
  // identically (wrong/expired/revoked/denied token, cancelled/soft-deleted meeting, corrupt
  // `party`) — see its own docblock for why that is the property this page relies on.
  const subject = await resolveMeetingGuestSubject(token);
  if (subject === null) {
    return <LinkNotActive />;
  }
  const { guest, meeting, side } = subject;

  const contexts = await meetingContextsRepository.listByMeeting(meeting.id);
  const primary = selectPrimaryMeetingContext(contexts);
  // BAL-445 §7 — resolved SERVER-SIDE, once, so the guest mount can register (or not
  // register) a Chat slot without ever flashing a button that opens onto nothing.
  // `conversationSubjectForMeetingContext` is the same pure mapping the guest chat arm
  // consumes; a `project_discovery` / `admin` / ambiguous primary maps to no envelope and
  // `hasChat` is `false`.
  const hasChat = primary.ok && conversationSubjectForMeetingContext(primary.context) !== null;

  const [parties, roster, inviterNames] = await Promise.all([
    resolveEngagementParties(primary),
    meetingGuestsRepository.listLiveByMeeting(meeting.id),
    // ⚠ `invitedById` IS NULLABLE SINCE MIGRATION 0064 (BAL-132): a self-claimed lobby row
    // has no inviter. Such a guest never reaches THIS route (they hold a lobby token, not a
    // `/join/{token}` magic link), but the type is honest and the branch is one line — the
    // empty batch falls straight through to the `'Someone'` fallback below.
    usersRepository.findNamesByIds(guest.invitedById === null ? [] : [guest.invitedById]),
  ]);

  // Compute first-open BEFORE stamping (`access_count === 0` pre-increment); the emit below
  // always pairs with this stamp.
  const firstOpen = guest.accessCount === 0;
  await meetingGuestsRepository.recordAccess(guest.id);

  trackServerAndFlush(GUEST_SERVER_EVENTS.GUEST_INVITE_OPENED, {
    party: side,
    access_scope: guest.accessScope,
    first_open: firstOpen,
    // ⚠ `meeting_guests.id` — a guest has NO user id. A stable pseudonymous handle.
    distinct_id: guest.id,
  });
  log.info('Guest join link opened', { guestId: guest.id, meetingId: meeting.id, firstOpen });

  const [inviter] = inviterNames;
  const inviterName = personDisplayName(
    inviter?.firstName ?? null,
    inviter?.lastName ?? null,
    'Someone'
  );
  // The inviter sits on the guest's OWN side — `party` is derived from the ACTOR's resolved
  // side at invite time, never sent by a client. Retrospective attribution therefore names the
  // person "@" THEIR org, and drops the clause entirely when it cannot be resolved.
  const inviterOrg = side === 'client' ? parties.clientCompanyName : parties.expertPartyLabel;
  const counterparty = side === 'client' ? parties.expertPartyLabel : parties.clientCompanyName;

  return (
    <InvitationView
      contextLabel={
        primary.ok ? CONTEXT_LABELS[primary.context.contextType] : GENERIC_CONTEXT_LABEL
      }
      hasEnded={meeting.status === 'ended'}
      isDelegate={guest.participationRole === 'delegate'}
      // ⚠ WEEKDAY-BEARING, matching the invite email's `Tue, 1 Sep 2026 …`. The reader is
      // working out whether they are free; the day of the week is the token they reason with.
      scheduledDate={formatUtcLongDateWithWeekday(meeting.scheduledStart)}
      scheduledWindow={formatScheduledWindow(meeting.scheduledStart, meeting.scheduledEnd)}
      // ⚠ `personWithOrgLabel`, NOT a bare `${name} @ ${org}`. For an INDEPENDENT expert the
      // party label IS the person, and concatenating rendered "Dana Okoro @ Dana Okoro".
      inviterAttribution={personWithOrgLabel(inviterName, inviterOrg)}
      counterparty={counterparty}
      // ⚠ NAMES ONLY, for BOTH sides — stricter than `projectGuestForViewer`. See the docblock.
      otherGuestNames={roster
        .filter((entry) => entry.id !== guest.id)
        .map((entry) => entry.name ?? ANONYMOUS_GUEST_LABEL)}
      accessScope={guest.accessScope}
      expiresOn={formatUtcLongDate(guest.expiresAt)}
      // BAL-132 — threaded to the join control. ⚠ The raw token goes to a POST-only Server
      // Action and is never rendered as text; see `JoinControl`.
      token={token}
      meetingId={meeting.id}
      scheduledStartIso={meeting.scheduledStart.toISOString()}
      scheduledEndIso={meeting.scheduledEnd.toISOString()}
      hasChat={hasChat}
    />
  );
}
