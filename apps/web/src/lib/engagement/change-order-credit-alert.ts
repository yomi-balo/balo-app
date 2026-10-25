import type { AdminAlertDetail } from '@balo/shared/admin-alerts';

interface ChangeOrderCreditAlertInput {
  projectTitle: string;
  clientCompanyName: string;
  /** The approving person, retrospective first mention: "Dana @ Northwind Industrial". */
  approverLabel: string;
  /** The delivering expert's party label. */
  expertLabel: string;
  /** Pre-formatted approval date, e.g. "6 Jul". */
  approvedOn: string;
}

/**
 * The `admin_alerts.detail` for an approved change that takes the project price below what the
 * client has already been invoiced (`project.change_order_credit_required`). Carries no amount:
 * the facts are read verbatim by every staff viewer.
 */
export function buildChangeOrderCreditAlertDetail(
  input: ChangeOrderCreditAlertInput
): AdminAlertDetail {
  return {
    title: `Credit needed on ${input.projectTitle}`,
    entityLabel: `${input.projectTitle} · ${input.clientCompanyName}`,
    evidence: `${input.approverLabel} approved a change on ${input.approvedOn} that takes the price below what ${input.clientCompanyName} has already been invoiced. Issue an adjustment note, then close this item.`,
    facts: [
      ['Client', input.clientCompanyName],
      ['Expert', input.expertLabel],
      ['Approved', input.approvedOn],
    ],
  };
}
