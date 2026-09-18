import { describe, expect, it } from 'vitest';
import {
  findStaffCandidateInputSchema,
  saveStaffAccessInputSchema,
  staffAccessStateSchema,
} from './staff-access-schema';

const VALID_STATE = { role: 'admin' as const, customList: null };
const TARGET_ID = 'b0000000-0000-4000-8000-000000000009';

describe('staffAccessStateSchema', () => {
  it('accepts a follow-role state (customList: null)', () => {
    expect(staffAccessStateSchema.safeParse(VALID_STATE).success).toBe(true);
  });

  it('accepts a custom list of unrestricted-shape tokens', () => {
    const result = staffAccessStateSchema.safeParse({
      role: 'admin',
      customList: ['resolve_admin_alerts', 'manage_promo_codes'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown role', () => {
    expect(staffAccessStateSchema.safeParse({ role: 'owner', customList: null }).success).toBe(
      false
    );
  });

  it('rejects an empty-string token in the list (min length 1)', () => {
    expect(staffAccessStateSchema.safeParse({ role: 'admin', customList: [''] }).success).toBe(
      false
    );
  });

  it('rejects an unknown key (.strict)', () => {
    const result = staffAccessStateSchema.safeParse({ ...VALID_STATE, extra: 1 });
    expect(result.success).toBe(false);
  });

  it("does NOT reject an unrecognised token string — that refusal is the mutator's job", () => {
    // Deliberately not a Zod enum: an unknown token reaches the mutator and comes back as the
    // named `unknown_capability` refusal, one definition of "known".
    const result = staffAccessStateSchema.safeParse({
      role: 'admin',
      customList: ['not_a_real_token'],
    });
    expect(result.success).toBe(true);
  });

  // F7 (R6) — pins Ruling 1's "explicit list value": `customList` is `.nullable()`, never
  // `.nullish()`. A caller must SAY `null` for follow-role; omitting the key, or sending
  // `undefined`, is a malformed payload, not a synonym for it.
  it('rejects a payload missing customList entirely', () => {
    const result = staffAccessStateSchema.safeParse({ role: 'admin' });
    expect(result.success).toBe(false);
  });

  it('rejects customList: undefined explicitly (would pass a .nullish() schema)', () => {
    const result = staffAccessStateSchema.safeParse({ role: 'admin', customList: undefined });
    expect(result.success).toBe(false);
  });
});

describe('saveStaffAccessInputSchema', () => {
  it('accepts a well-formed payload', () => {
    const result = saveStaffAccessInputSchema.safeParse({
      targetUserId: TARGET_ID,
      expected: VALID_STATE,
      next: { role: 'super_admin', customList: null },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-uuid targetUserId', () => {
    const result = saveStaffAccessInputSchema.safeParse({
      targetUserId: 'not-a-uuid',
      expected: VALID_STATE,
      next: VALID_STATE,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level key (.strict)', () => {
    const result = saveStaffAccessInputSchema.safeParse({
      targetUserId: TARGET_ID,
      expected: VALID_STATE,
      next: VALID_STATE,
      hax: 1,
    });
    expect(result.success).toBe(false);
  });

  // F7 (R6) — the same "explicit list value" pin, exercised through the composed schema on
  // BOTH `next` and `expected`, not just the shared `staffAccessStateSchema` in isolation.
  it('rejects a next missing customList entirely', () => {
    const result = saveStaffAccessInputSchema.safeParse({
      targetUserId: TARGET_ID,
      expected: VALID_STATE,
      next: { role: 'admin' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an expected missing customList entirely', () => {
    const result = saveStaffAccessInputSchema.safeParse({
      targetUserId: TARGET_ID,
      expected: { role: 'admin' },
      next: VALID_STATE,
    });
    expect(result.success).toBe(false);
  });

  it('rejects next: { ..., customList: undefined }', () => {
    const result = saveStaffAccessInputSchema.safeParse({
      targetUserId: TARGET_ID,
      expected: VALID_STATE,
      next: { role: 'admin', customList: undefined },
    });
    expect(result.success).toBe(false);
  });
});

describe('findStaffCandidateInputSchema', () => {
  it('accepts a full email address', () => {
    expect(findStaffCandidateInputSchema.safeParse({ email: 'dana@example.com' }).success).toBe(
      true
    );
  });

  it('trims before validating', () => {
    const result = findStaffCandidateInputSchema.safeParse({ email: '  dana@example.com  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe('dana@example.com');
  });

  it('rejects a partial address', () => {
    expect(findStaffCandidateInputSchema.safeParse({ email: 'dana@' }).success).toBe(false);
    expect(findStaffCandidateInputSchema.safeParse({ email: 'dana@northwind' }).success).toBe(
      false
    );
  });

  it('rejects an unknown key (.strict)', () => {
    const result = findStaffCandidateInputSchema.safeParse({
      email: 'dana@example.com',
      hax: 1,
    });
    expect(result.success).toBe(false);
  });
});
