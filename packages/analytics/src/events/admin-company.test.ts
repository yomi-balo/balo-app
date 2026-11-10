import { describe, it, expect } from 'vitest';
import { ADMIN_COMPANY_SERVER_EVENTS } from './admin-company';

describe('ADMIN_COMPANY_SERVER_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(ADMIN_COMPANY_SERVER_EVENTS)).toEqual([
      'INDUSTRY_SET',
      'REVIEW_NAME_TOGGLED',
    ]);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(ADMIN_COMPANY_SERVER_EVENTS.INDUSTRY_SET).toBe('admin_company_industry_set');
    expect(ADMIN_COMPANY_SERVER_EVENTS.REVIEW_NAME_TOGGLED).toBe(
      'admin_company_review_name_toggled'
    );
  });

  it('values follow the snake_case naming convention', () => {
    for (const value of Object.values(ADMIN_COMPANY_SERVER_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});
