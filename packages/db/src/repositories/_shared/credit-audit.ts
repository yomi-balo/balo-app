import { auditEventsRepository } from '../audit-events';
import type { CreditEntryType, CreditLedgerReason } from '../../schema';
import type { DbExecutor } from './db-executor';

/**
 * The credit audit vocabulary (BAL-376 / ADR-1030). `audit_events` (BAL-344) stores
 * `action`/`entityType` as open `text`, so this union keeps OUR emitted taxonomy
 * typo-safe at compile time WITHOUT the generic repo needing to know it — the same
 * discipline as `DeliveryAuditAction`. Only member-attributed money events (a
 * `session_consume` or `overdraft_settlement` ledger entry) write a row.
 */
export type CreditAuditAction =
  | 'credit_wallet.consumed' // a session_consume ledger entry, member-attributed
  | 'credit_wallet.settled'; // an overdraft_settlement ledger entry, member-attributed

/** Subject of a credit audit row is always the wallet (entity_id = wallet_id). */
export type CreditAuditEntityType = 'credit_wallet';

/**
 * The money/session/company context folded into `audit_events.metadata` — that table
 * (BAL-344) has NO `company_id`/`session_id`/`subject_*` columns, so this record is
 * how they are preserved for a "history of one wallet" read. Deliberately carries NO
 * margin/markup/fee-bps/expert-quote (invariant #2).
 */
export interface CreditAuditContext {
  ledgerEntryId: string;
  companyId: string;
  sessionId?: string | null;
  entryType: CreditEntryType;
  reason: CreditLedgerReason;
  amountMinor: number;
  balanceAfterMinor: number;
}

export interface RecordCreditAuditInput extends CreditAuditContext {
  actorUserId: string | null; // the acting member
  action: CreditAuditAction;
  walletId: string; // → audit_events.entity_id (subject = the wallet)
}

/**
 * Record ONE credit audit event inside the caller's transaction (pass the `tx` handle
 * — it satisfies `DbExecutor`), so the audit row commits or rolls back WITH the ledger
 * insert + balance update (invariant #7). The subject is the wallet; the actor is the
 * member; every remaining field folds into `metadata`.
 */
export async function recordCreditAudit(
  exec: DbExecutor,
  input: RecordCreditAuditInput
): Promise<void> {
  // Split the row-shape fields (actor/action/subject) from the money context; the
  // remainder IS the metadata payload — a structurally different fold from
  // delivery-audit's single-key spread.
  const { actorUserId, action, walletId, ...context } = input;
  const entityType: CreditAuditEntityType = 'credit_wallet';

  await auditEventsRepository.record(
    { actorUserId, action, entityType, entityId: walletId, metadata: { ...context } },
    exec
  );
}
