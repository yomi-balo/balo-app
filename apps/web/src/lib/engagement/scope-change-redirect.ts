import { z } from 'zod';
import type { ScopeChangeRedirectReason } from '@balo/shared/engagements';

/**
 * Why the expert is being sent to propose a change, in one sentence naming the client
 * company. Shown in place of a generic failure when a plain milestone edit needs approval.
 */
const MESSAGE_BY_REASON: Record<ScopeChangeRedirectReason, (client: string) => string> = {
  estimate_change: (client) =>
    `Changing an estimate on a time-and-materials project needs ${client}'s approval first. Propose it as a change.`,
  add_on_tm: (client) =>
    `Adding a milestone on a time-and-materials project needs ${client}'s approval first. Propose it as a change.`,
  remove_contracted: (client) =>
    `This milestone is part of the scope ${client} agreed to, so removing it needs their approval first. Propose it as a change.`,
};

export function scopeChangeMessage(
  reason: ScopeChangeRedirectReason,
  clientCompanyName: string
): string {
  return MESSAGE_BY_REASON[reason](clientCompanyName);
}

/**
 * The attempted change the change-order composer opens with a line already added: a blank
 * new milestone, or the removal of a named one.
 */
export type ChangeOrderPrefill = { op: 'add' } | { op: 'remove'; milestoneId: string };

/** The composer link for an attempted change; `null` links to the bare composer. */
export function changeOrderPrefillHref(
  composerHref: string,
  prefill: ChangeOrderPrefill | null
): string {
  if (prefill === null) return composerHref;
  const params = new URLSearchParams({ prefill: prefill.op });
  if (prefill.op === 'remove') params.set('milestone', prefill.milestoneId);
  return `${composerHref}?${params.toString()}`;
}

const prefillSchema = z.discriminatedUnion('prefill', [
  z.object({ prefill: z.literal('add') }),
  z.object({ prefill: z.literal('remove'), milestone: z.uuid() }),
]);

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Reads a prefill off the composer's search params; anything malformed yields `null`. */
export function parseChangeOrderPrefill(
  params: Record<string, string | string[] | undefined>
): ChangeOrderPrefill | null {
  const parsed = prefillSchema.safeParse({
    prefill: firstValue(params.prefill),
    milestone: firstValue(params.milestone),
  });
  if (!parsed.success) return null;
  const data = parsed.data;
  return data.prefill === 'remove' ? { op: 'remove', milestoneId: data.milestone } : { op: 'add' };
}
