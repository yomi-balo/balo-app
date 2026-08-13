import 'server-only';

import { companiesRepository } from '@balo/db';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import type { CaseAccess } from '@/lib/cases/resolve-case-access';

/**
 * BAL-421 — WHO a case-thread message or file share notifies, and the publish itself.
 *
 * ⚠ SHARED BY BOTH WRITERS (`post-case-message.ts` and `confirm-case-file-upload.ts`) RATHER
 * THAN COPIED. The two events differ by exactly one payload field (`preview` vs `fileName`);
 * everything else — the recipient resolution, the `engagement` anchor triple, the swallowed
 * rejection — is identical, which is the >3% new-code duplication shape the SonarCloud gate
 * exists to catch. It is also the shape that drifts: a recipient rule fixed in one writer and
 * not the other means half the notifications silently go to nobody.
 *
 * ⚠ FEATURE CODE PUBLISHES; THE ENGINE DECIDES CHANNELS AND DELIVERY. Nothing here imports
 * Brevo, writes a notification row, or sends an email.
 *
 * ⚠ NO NEW EVENT IS MINTED. `conversation.message_posted` and `conversation.file_shared` are
 * complete end-to-end on `main`, and BAL-424 built their `engagement` arm FOR THIS SURFACE:
 * `ConversationMessagePostedPayload.contextType` is `'relationship' | 'engagement'` and
 * `engagementId` is documented as "present ONLY on the `engagement` arm". The case is that
 * arm's first producer.
 */

/**
 * The recipient triple the notification rules route on.
 *
 * ⚠ THE RECIPIENT IS THE **OTHER** SIDE, DERIVED FROM THE SENDER'S GATE-RESOLVED LENS — never
 * from input, and never from `activeMode`.
 */
export interface CaseNotifyTargets {
  recipientRole: 'client' | 'expert';
  /** Set when `recipientRole === 'client'` → the dispatcher's client path. */
  recipientId?: string;
  /** Set when `recipientRole === 'expert'` → the resolver hydrates `data.expert`. */
  expertProfileId?: string;
}

/**
 * Resolve the counterparty for a case thread.
 *
 * ⚠ `findOwnerUserIdByCompanyId` IS THE NON-THROWING VARIANT, AND THAT IS THE RIGHT ONE HERE.
 * Its own docblock names "resolving a notification recipient" as the case it exists for: a
 * company with no live owner is an EXPECTED, non-fatal state (the client rule skips
 * gracefully on an absent `recipientId`), while a transient DB error still throws so the
 * caller can retry. The throwing `findOwnerByCompanyId` would turn a genuinely ownerless
 * company into a failed message send.
 *
 * ⚠⚠ IT CAN STILL REJECT, SO A POST-COMMIT CALLER **MUST** `.catch` IT. "Non-throwing" here
 * means only that an OWNERLESS company is not an error; a transient DB error still rejects. Both
 * writers call this AFTER the row is committed and AFTER `publishConversationEvent` has pushed
 * to Ably, so an unguarded rejection would surface as "could not send" for a message the sender
 * can already SEE — and the retry would double-post. They each degrade a rejection to NO
 * fan-out; do not "simplify" either guard away.
 */
export async function resolveCaseNotifyTargets(access: CaseAccess): Promise<CaseNotifyTargets> {
  if (access.lens === 'client') {
    // A client sent it ⇒ the delivering expert is notified.
    return { recipientRole: 'expert', expertProfileId: access.expertProfileId };
  }
  // An expert sent it ⇒ the client company's owner is notified.
  return {
    recipientRole: 'client',
    recipientId: await companiesRepository.findOwnerUserIdByCompanyId(access.companyId),
  };
}

/**
 * The POST-COMMIT half of both writers, in ONE place: resolve the case title and the
 * recipients, with each read individually guarded so neither can fail a write that has
 * already committed AND already gone out over Ably.
 *
 * ⚠⚠ THIS IS THE GUARD, NOT A CONVENIENCE WRAPPER. `resolveCaseNotifyTargets` reaches
 * `companiesRepository.findOwnerUserIdByCompanyId` on the expert lens, which still REJECTS on
 * a transient DB error (see its docblock). Called unguarded after the insert, that rejection
 * surfaces as "could not send" for a message the sender can already SEE in their own thread —
 * and the retry double-posts, or trips `conversation_file_key_idx` and reports "already
 * shared". Degrading to NO fan-out is the correct trade: a missed notification beats a
 * phantom failure. Do not "simplify" either `.catch` away.
 *
 * `targets: undefined` means DO NOT PUBLISH. `title` degrades to a neutral label rather than
 * blocking the notification, because a nameless case still beats silence.
 */
export async function resolveCaseNotifyContext(input: {
  access: CaseAccess;
  engagementId: string;
  conversationId: string;
  userId: string;
  /** Injected so this module keeps its single `@balo/db` import surface. */
  findCaseTitle: (engagementId: string) => Promise<{ title: string } | undefined>;
  onTargetsFailed: (error: unknown) => void;
}): Promise<{ title: string; targets: CaseNotifyTargets | undefined }> {
  const [caseRow, targets] = await Promise.all([
    input.findCaseTitle(input.engagementId).catch(() => undefined),
    resolveCaseNotifyTargets(input.access).catch((error: unknown) => {
      input.onTargetsFailed(error);
      return undefined;
    }),
  ]);
  return { title: caseRow?.title ?? 'your case', targets };
}

/** The anchor fields both events share, plus the sender and recipient. */
interface CaseNotifyBase {
  access: CaseAccess;
  targets: CaseNotifyTargets;
  /** The case title — the thread title in both templates. */
  title: string;
  senderName: string;
  /** `conversation_messages.id` or `conversation_files.id` — the dispatcher's dedupe key. */
  correlationId: string;
}

/**
 * Publish `conversation.message_posted` on the ENGAGEMENT arm. Fire-and-forget by contract:
 * `publishNotificationEvent` logs internally and never throws to the caller, and a failed
 * notification must never fail a message that is already persisted.
 */
export function publishCaseMessagePosted(input: CaseNotifyBase & { preview: string }): void {
  publishNotificationEvent('conversation.message_posted', {
    correlationId: input.correlationId,
    conversationId: input.access.conversationId,
    contextType: 'engagement',
    contextId: input.access.engagementId,
    // ⚠ Present ONLY on the `engagement` arm, and equal to `contextId` — kept explicit
    // because the template deep-links `/cases/{engagementId}` from it.
    engagementId: input.access.engagementId,
    title: input.title,
    senderName: input.senderName,
    recipientRole: input.targets.recipientRole,
    recipientId: input.targets.recipientId,
    expertProfileId: input.targets.expertProfileId,
    preview: input.preview,
    // ⚠ ALWAYS FALSE HERE. This composer is the CASE SURFACE, never the in-call panel
    // (BAL-132 owns that one). The flag drives analytics and copy, never routing.
    sentDuringMeeting: false,
  }).catch(() => {
    // publishNotificationEvent logs internally.
  });
}

/**
 * Publish `conversation.file_shared` on the ENGAGEMENT arm. Rides the SAME 10-minute
 * unread-digest promise and the same dedupe key as the message event, so a message plus a
 * file inside one window folds into ONE email.
 */
export function publishCaseFileShared(input: CaseNotifyBase & { fileName: string }): void {
  publishNotificationEvent('conversation.file_shared', {
    correlationId: input.correlationId,
    conversationId: input.access.conversationId,
    contextType: 'engagement',
    contextId: input.access.engagementId,
    engagementId: input.access.engagementId,
    title: input.title,
    senderName: input.senderName,
    recipientRole: input.targets.recipientRole,
    recipientId: input.targets.recipientId,
    expertProfileId: input.targets.expertProfileId,
    fileName: input.fileName,
  }).catch(() => {
    // publishNotificationEvent logs internally.
  });
}
