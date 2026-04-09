import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generateCronofyAuthUrl, handleOAuthCallback } from '../../services/cronofy/oauth.js';
import { requireInternalAuth } from '../../lib/internal-auth.js';
import { trackServer, CALENDAR_SERVER_EVENTS } from '@balo/analytics/server';

// ── Validation ──────────────────────────────────────────────────

const connectBodySchema = z.object({
  expertProfileId: z.string().uuid(),
  provider: z.enum(['google', 'microsoft']),
});

const callbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

// ── Routes ──────────────────────────────────────────────────────

export async function calendarAuthRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/calendar/connect
   * Generates a Cronofy authorization URL and returns it.
   * Protected by requireInternalAuth — called from server actions, not directly from browser.
   */
  fastify.post(
    '/api/calendar/connect',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const parsed = connectBodySchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid request body',
          details: parsed.error.issues.map((i: { message: string }) => i.message),
        });
      }

      const { expertProfileId, provider } = parsed.data;

      try {
        const authUrl = generateCronofyAuthUrl(expertProfileId, provider);
        return reply.send({ authUrl });
      } catch (err: unknown) {
        request.log.error(
          {
            expertProfileId,
            provider,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          'Failed to generate Cronofy auth URL'
        );
        return reply.status(500).send({ error: 'Failed to initiate calendar connection' });
      }
    }
  );

  /**
   * GET /auth/cronofy/callback
   * Handles the Cronofy OAuth callback, exchanges the code for tokens,
   * and redirects back to the web app with success/error params.
   */
  fastify.get('/auth/cronofy/callback', async (request, reply) => {
    const parsed = callbackQuerySchema.safeParse(request.query);
    const webAppUrl = process.env.WEB_APP_URL || 'http://localhost:3000';
    const settingsPath = '/expert/settings?tab=calendar';

    if (!parsed.success) {
      request.log.warn('Invalid OAuth callback query params');
      return reply.redirect(`${webAppUrl}${settingsPath}&calendar_error=invalid_callback`);
    }

    const { code, state } = parsed.data;

    try {
      const result = await handleOAuthCallback(code, state);

      trackServer(CALENDAR_SERVER_EVENTS.OAUTH_COMPLETED, {
        provider: result.provider,
        status: result.status,
        distinct_id: result.expertProfileId,
      });

      return reply.redirect(
        `${webAppUrl}${settingsPath}&calendar_connected=true&calendar_status=${result.status}`
      );
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Classify error into a safe, fixed error code — never leak internal details in URL
      const isExpired = errorMessage.includes('expired');
      const isSignature = errorMessage.includes('signature') || errorMessage.includes('state');
      const isO365AdminApproval =
        errorMessage.includes('access_denied') ||
        errorMessage.includes('consent_required') ||
        errorMessage.includes('admin_approval');
      let errorCode = 'callback_failed';
      if (isExpired) errorCode = 'state_expired';
      else if (isSignature) errorCode = 'invalid_state';
      else if (isO365AdminApproval) errorCode = 'o365_admin_approval';

      // Best-effort: extract provider from the state payload for the error redirect.
      // The state format is base64(payload).base64(hmac) — we parse payload without
      // verifying the signature so this works even for expired/tampered states.
      let providerParam = '';
      try {
        const payloadB64 = state.split('.')[0];
        if (payloadB64) {
          const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as {
            provider?: string;
          };
          if (payload.provider === 'google' || payload.provider === 'microsoft') {
            providerParam = `&calendar_provider=${payload.provider}`;
          }
        }
      } catch {
        // Best effort — provider is cosmetic for the error UI
      }

      request.log.error(
        {
          error: errorMessage,
          stack: err instanceof Error ? err.stack : undefined,
          errorCode,
        },
        'Cronofy OAuth callback failed'
      );

      trackServer(CALENDAR_SERVER_EVENTS.OAUTH_FAILED, {
        error_message: errorMessage,
        distinct_id: 'unknown',
      });

      return reply.redirect(
        `${webAppUrl}${settingsPath}&calendar_error=${errorCode}${providerParam}`
      );
    }
  });
}
