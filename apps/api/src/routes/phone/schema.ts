import { z } from 'zod';

export const sendOtpBodySchema = z.object({
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/, 'Must be E.164 format'),
});

export const verifyOtpBodySchema = z.object({
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/, 'Must be E.164 format'),
  code: z
    .string()
    .length(6)
    .regex(/^\d{6}$/, 'Must be 6 digits'),
});

export type SendOtpBody = z.infer<typeof sendOtpBodySchema>;
export type VerifyOtpBody = z.infer<typeof verifyOtpBodySchema>;
