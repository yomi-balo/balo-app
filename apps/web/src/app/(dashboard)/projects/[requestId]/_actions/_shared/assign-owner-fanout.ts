import 'server-only';

import { runAfterResponse } from '@/lib/after-response';
import { publishNotificationEventNow } from '@/lib/notifications/publish';

/**
 * BAL-541 — everything the `assignOwner` commit still owes AFTER the transaction has landed:
 * the `project.request_owner_assigned` telling. Server-only, NOT a `'use server'` module — it
 * exports a non-async function whose only job is to schedule work, mirroring
 * `close-request-fanout.ts`'s shape (a `'use server'` file may export ONLY async functions —
 * memory `reference_use_server_no_value_exports`).
 *
 * Deferred to `runAfterResponse` (BAL-279) for the same reason as every other post-commit
 * fan-out in this directory: a Vercel function freeze right after the Server Action returns
 * cannot drop it. `runAfterResponse` never retries and the assignment has already committed —
 * a dropped publish here is a lost notice, not a lost assignment.
 *
 * ⚠ IT PERFORMS NO READ OF ITS OWN. Every field is either already-committed state
 * (`correlationId` = the audit row id) or came from the request row the caller already had in
 * hand — nothing here can fail except the publish itself.
 *
 * ⚠ NEVER CALLED ON A CLEAR (`ownerUserId === null`, D11) — the caller only invokes this when
 * `assignOwner` returned a non-null `ownerUserId`. This function does not defend against being
 * called with a null owner because there is no such shape to accept: `newOwnerUserId` is a
 * required, non-null `string`.
 *
 * Analytics does NOT belong here — D4 fires `PROJECT_EVENTS.REQUEST_OWNER_ASSIGNED` CLIENT-side
 * from `balo-panel.tsx` off the action's returned `analytics` object, not from this server-only
 * fan-out (server events would force an edit to `PROJECT_SERVER_EVENTS`'s exact-key-set test —
 * out of scope here).
 */
export interface AssignOwnerFanoutContext {
  /** The `project_request.owner_assigned` audit row id — a uuid, so COLON-FREE by construction. */
  correlationId: string;
  projectRequestId: string;
  /** The NEW owner — never called on a clear. */
  newOwnerUserId: string;
  assignedByUserId: string;
  title: string;
  clientCompanyName: string;
}

export function runAssignOwnerFanout(context: AssignOwnerFanoutContext): void {
  runAfterResponse('assign owner fan-out', async () => {
    await publishNotificationEventNow('project.request_owner_assigned', {
      correlationId: context.correlationId,
      projectRequestId: context.projectRequestId,
      userId: context.newOwnerUserId,
      assignedByUserId: context.assignedByUserId,
      title: context.title,
      clientCompanyName: context.clientCompanyName,
    });
  });
}
