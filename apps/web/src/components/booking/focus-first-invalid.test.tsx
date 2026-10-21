import { afterEach, describe, expect, it } from 'vitest';
import { BOOKING_FIELD_IDS, findFirstInvalidField } from './focus-first-invalid';

const VALID = {
  isNewCase: true,
  title: 'A title',
  descriptionHtml: '<p>Words</p>',
  companyMissing: false,
};

function mountFields(): void {
  document.body.innerHTML = `
    <input id="${BOOKING_FIELD_IDS.title}" />
    <div id="${BOOKING_FIELD_IDS.description}"><div contenteditable="true"></div></div>
    <button id="${BOOKING_FIELD_IDS.company}"></button>`;
}

describe('findFirstInvalidField', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns the title first when it is blank', () => {
    mountFields();
    expect(findFirstInvalidField({ ...VALID, title: '   ', descriptionHtml: '' })?.id).toBe(
      BOOKING_FIELD_IDS.title
    );
  });

  it('returns the description editor when only the description is empty', () => {
    mountFields();
    const found = findFirstInvalidField({ ...VALID, descriptionHtml: '<p></p>' });
    expect(found?.getAttribute('contenteditable')).toBe('true');
  });

  it('falls back to the description wrapper when the editor has not mounted', () => {
    document.body.innerHTML = `<div id="${BOOKING_FIELD_IDS.description}"></div>`;
    expect(findFirstInvalidField({ ...VALID, descriptionHtml: '' })?.id).toBe(
      BOOKING_FIELD_IDS.description
    );
  });

  it('returns the company picker when only the company is missing', () => {
    mountFields();
    expect(findFirstInvalidField({ ...VALID, companyMissing: true })?.id).toBe(
      BOOKING_FIELD_IDS.company
    );
  });

  it('skips the text fields for an attached case', () => {
    mountFields();
    expect(
      findFirstInvalidField({
        isNewCase: false,
        title: '',
        descriptionHtml: '',
        companyMissing: false,
      })
    ).toBeNull();
  });

  it('returns null when every field is valid', () => {
    mountFields();
    expect(findFirstInvalidField(VALID)).toBeNull();
  });
});
