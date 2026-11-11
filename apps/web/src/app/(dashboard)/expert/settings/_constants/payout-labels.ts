import type { NormalizedField } from '../_components/payouts-tab';

export const COMPANY_LABEL_OVERRIDES: Record<string, string> = {
  'beneficiary.bank_details.account_name': 'Account Holder Name',
  'beneficiary.company_name': 'Business Name',
  'beneficiary.first_name': 'Contact First Name',
  'beneficiary.last_name': 'Contact Last Name',
};

export const ROUTING_TYPE_PATH = 'beneficiary.bank_details.account_routing_type1';
export const ROUTING_VALUE_PATH = 'beneficiary.bank_details.account_routing_value1';

/** Routing-code label by routing type; the type, not the country, keys the copy. */
export const ROUTING_VALUE_LABELS: Record<string, string> = {
  aba: 'ACH routing number',
  bsb: 'BSB',
  sort_code: 'Sort code',
};

export const FIELD_DESCRIPTION_OVERRIDES: Record<string, string> = {
  'beneficiary.address.street_address': 'Must not be a PO box',
};

/** Balo wording for a schema's fields, applied once at fetch time. */
export function applyPayoutFieldCopy(
  fields: NormalizedField[],
  hiddenDefaults: Record<string, string>
): NormalizedField[] {
  const routingLabel = ROUTING_VALUE_LABELS[hiddenDefaults[ROUTING_TYPE_PATH] ?? ''];
  return fields.map((field) => {
    const routingOverride = field.path === ROUTING_VALUE_PATH ? routingLabel : undefined;
    const description = FIELD_DESCRIPTION_OVERRIDES[field.path] ?? field.description;
    return {
      ...field,
      label: COMPANY_LABEL_OVERRIDES[field.path] ?? routingOverride ?? field.label,
      ...(description === undefined ? {} : { description }),
    };
  });
}

/** Label for a saved value, derived from its path and the saved routing type. */
export function savedPayoutFieldLabel(path: string, formValues: Record<string, string>): string {
  const override = COMPANY_LABEL_OVERRIDES[path];
  if (override !== undefined) return override;
  if (path === ROUTING_VALUE_PATH) {
    return ROUTING_VALUE_LABELS[formValues[ROUTING_TYPE_PATH] ?? ''] ?? 'Routing code';
  }
  const lastSegment = path.split('.').pop() ?? path;
  return lastSegment.replaceAll('_', ' ').replace(/\b\w/g, (l) => l.toUpperCase());
}
