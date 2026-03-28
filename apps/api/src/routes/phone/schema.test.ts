import { describe, it, expect } from 'vitest';
import { sendOtpBodySchema, verifyOtpBodySchema } from './schema.js';

describe('sendOtpBodySchema', () => {
  it('accepts a valid E.164 phone number', () => {
    const result = sendOtpBodySchema.safeParse({ phone: '+61412345678' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ phone: '+61412345678' });
  });

  it('accepts a US E.164 phone number', () => {
    const result = sendOtpBodySchema.safeParse({ phone: '+14155551234' });
    expect(result.success).toBe(true);
  });

  it('rejects a number without leading +', () => {
    const result = sendOtpBodySchema.safeParse({ phone: '61412345678' });
    expect(result.success).toBe(false);
  });

  it('rejects a local number without country code', () => {
    const result = sendOtpBodySchema.safeParse({ phone: '412345678' });
    expect(result.success).toBe(false);
  });

  it('rejects alphabetic input', () => {
    const result = sendOtpBodySchema.safeParse({ phone: 'abc' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty string', () => {
    const result = sendOtpBodySchema.safeParse({ phone: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing phone field', () => {
    const result = sendOtpBodySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects +0 leading country code', () => {
    const result = sendOtpBodySchema.safeParse({ phone: '+0412345678' });
    expect(result.success).toBe(false);
  });
});

describe('verifyOtpBodySchema', () => {
  it('accepts a valid phone and 6-digit code', () => {
    const result = verifyOtpBodySchema.safeParse({
      phone: '+61412345678',
      code: '123456',
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ phone: '+61412345678', code: '123456' });
  });

  it('accepts code with leading zeros', () => {
    const result = verifyOtpBodySchema.safeParse({
      phone: '+61412345678',
      code: '000001',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a 5-digit code', () => {
    const result = verifyOtpBodySchema.safeParse({
      phone: '+61412345678',
      code: '12345',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a 7-digit code', () => {
    const result = verifyOtpBodySchema.safeParse({
      phone: '+61412345678',
      code: '1234567',
    });
    expect(result.success).toBe(false);
  });

  it('rejects code with letters', () => {
    const result = verifyOtpBodySchema.safeParse({
      phone: '+61412345678',
      code: '12ab56',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty code', () => {
    const result = verifyOtpBodySchema.safeParse({
      phone: '+61412345678',
      code: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing code field', () => {
    const result = verifyOtpBodySchema.safeParse({
      phone: '+61412345678',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing phone field', () => {
    const result = verifyOtpBodySchema.safeParse({
      code: '123456',
    });
    expect(result.success).toBe(false);
  });
});
