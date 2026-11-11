import { describe, it, expect } from 'vitest';
import type { NormalizedField } from '../_types/payout-schema';
import {
  applyPayoutFieldCopy,
  savedPayoutFieldLabel,
  ROUTING_TYPE_PATH,
  ROUTING_VALUE_PATH,
} from './payout-labels';

const STREET = 'beneficiary.address.street_address';

function field(path: string, label: string, description = ''): NormalizedField {
  return {
    path,
    required: true,
    label,
    description,
    placeholder: '',
    tip: '',
    type: 'text',
    defaultValue: '',
    refresh: false,
    wide: false,
  };
}

// Trimmed from the live Airwallex schema (LOCAL / COMPANY) for each country.
const SCHEMAS: Record<
  string,
  { fields: NormalizedField[]; hiddenDefaults: Record<string, string> }
> = {
  US: {
    fields: [
      field(ROUTING_VALUE_PATH, 'Routing code value'),
      field(STREET, 'Address', 'Should not be a PO or GPO box address'),
    ],
    hiddenDefaults: { [ROUTING_TYPE_PATH]: 'aba', 'beneficiary.type': 'BANK_ACCOUNT' },
  },
  AU: {
    fields: [field(ROUTING_VALUE_PATH, 'BSB')],
    hiddenDefaults: { [ROUTING_TYPE_PATH]: 'bsb', 'beneficiary.type': 'BANK_ACCOUNT' },
  },
  GB: {
    fields: [
      field(ROUTING_VALUE_PATH, 'Sort code'),
      field(STREET, 'Address', 'Should not be a PO or GPO box address'),
    ],
    hiddenDefaults: { [ROUTING_TYPE_PATH]: 'sort_code', 'beneficiary.type': 'BANK_ACCOUNT' },
  },
};

function labelOf(fields: NormalizedField[], path: string): string | undefined {
  return fields.find((f) => f.path === path)?.label;
}

describe('applyPayoutFieldCopy', () => {
  it.each([
    ['US', 'ACH routing number'],
    ['AU', 'BSB'],
    ['GB', 'Sort code'],
  ])('labels the %s routing code "%s"', (country, expected) => {
    const schema = SCHEMAS[country];
    if (schema === undefined) throw new Error('missing fixture');
    const out = applyPayoutFieldCopy(schema.fields, schema.hiddenDefaults);
    expect(labelOf(out, ROUTING_VALUE_PATH)).toBe(expected);
  });

  it.each(['US', 'GB'])('rewrites the %s street address hint', (country) => {
    const schema = SCHEMAS[country];
    if (schema === undefined) throw new Error('missing fixture');
    const out = applyPayoutFieldCopy(schema.fields, schema.hiddenDefaults);
    expect(out.find((f) => f.path === STREET)?.description).toBe('Must not be a PO box');
  });

  it('keeps the Airwallex label for an unknown routing type', () => {
    const out = applyPayoutFieldCopy([field(ROUTING_VALUE_PATH, 'IFSC')], {
      [ROUTING_TYPE_PATH]: 'ifsc',
    });
    expect(labelOf(out, ROUTING_VALUE_PATH)).toBe('IFSC');
  });

  it('keeps a company override ahead of the Airwallex label', () => {
    const out = applyPayoutFieldCopy([field('beneficiary.company_name', 'Company name')], {});
    expect(labelOf(out, 'beneficiary.company_name')).toBe('Business Name');
  });

  it('leaves other descriptions untouched', () => {
    const out = applyPayoutFieldCopy([field('beneficiary.city', 'City', 'Your city')], {});
    expect(out[0]?.description).toBe('Your city');
  });
});

describe('savedPayoutFieldLabel', () => {
  it('labels an aba routing value "ACH routing number"', () => {
    expect(savedPayoutFieldLabel(ROUTING_VALUE_PATH, { [ROUTING_TYPE_PATH]: 'aba' })).toBe(
      'ACH routing number'
    );
  });

  it('falls back to "Routing code" when no routing type was saved', () => {
    expect(savedPayoutFieldLabel(ROUTING_VALUE_PATH, {})).toBe('Routing code');
  });

  it('title-cases the last path segment otherwise', () => {
    expect(savedPayoutFieldLabel('beneficiary.address.city', {})).toBe('City');
  });

  it('prefers a company override', () => {
    expect(savedPayoutFieldLabel('beneficiary.company_name', {})).toBe('Business Name');
  });
});
