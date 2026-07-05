'use client';

import { useCallback, useTransition } from 'react';
import { Bell, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import { remindClientBilling } from '@/app/(dashboard)/projects/[requestId]/_actions/remind-client-billing';

interface RemindClientButtonProps {
  requestId: string;
  relationshipId: string;
}

/**
 * BAL-324 — admin-only "Remind client" action. Fires the `remindClientBilling`
 * server action (which publishes the billing-reminder event through the
 * notification engine), toasts the outcome, and — on success — fires the
 * `project_billing_reminder_sent` analytics event from the server-computed result.
 * Stays available after success so an admin can send a genuine second reminder
 * (each click mints a fresh correlationId server-side, so it is never a no-op).
 * The parent hides this entirely once the gate confirms.
 */
export function RemindClientButton({
  requestId,
  relationshipId,
}: Readonly<RemindClientButtonProps>): React.JSX.Element {
  const [pending, startTransition] = useTransition();

  const handleClick = useCallback((): void => {
    if (pending) return;
    // React 19 async transition: pass the async fn directly so `pending` stays true
    // for the whole in-flight action (a fire-and-forget IIFE would clear it at once).
    startTransition(async (): Promise<void> => {
      const result = await remindClientBilling({ requestId, relationshipId });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      track(PROJECT_EVENTS.BILLING_REMINDER_SENT, {
        request_id: requestId,
        company_id: result.companyId,
        admin_user_id: result.adminUserId,
        recipient_count: result.recipientCount,
        days_since_acceptance: result.daysSinceAcceptance,
      });
      toast.success('Reminder sent');
    });
  }, [pending, requestId, relationshipId]);

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={pending}
      aria-label="Remind client to add billing details"
      className="bg-primary text-primary-foreground focus-visible:ring-ring inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <Bell className="h-4 w-4" aria-hidden="true" />
      )}
      Remind client
    </button>
  );
}
