import { describe, expect, it } from 'vitest';
import { parseMuxWebhookEvent } from './webhook-events.js';

const RECORDING_ID = '11111111-1111-4111-8111-111111111111';
const ASSET_ID = 'asset_abc123';

describe('parseMuxWebhookEvent (BAL-473 §8.6)', () => {
  it('refuses an envelope with no `id`', () => {
    expect(parseMuxWebhookEvent({ type: 'video.asset.ready', data: {} })).toEqual({
      ok: false,
      reason: 'malformed_envelope',
    });
  });

  it('refuses a blank `id`', () => {
    expect(parseMuxWebhookEvent({ id: '', type: 'video.asset.ready' })).toEqual({
      ok: false,
      reason: 'malformed_envelope',
    });
  });

  it('refuses an envelope with no `type`', () => {
    expect(parseMuxWebhookEvent({ id: 'evt_1' })).toEqual({
      ok: false,
      reason: 'malformed_envelope',
    });
  });

  it('refuses a non-object body', () => {
    expect(parseMuxWebhookEvent('nonsense')).toEqual({ ok: false, reason: 'malformed_envelope' });
  });

  it('⚠ an unknown type is `unhandled`, never a parse failure — never floods the retry queue', () => {
    const result = parseMuxWebhookEvent({
      id: 'evt_1',
      type: 'video.upload.asset_created',
      data: { passthrough: RECORDING_ID },
    });

    expect(result).toEqual({
      ok: true,
      event: {
        kind: 'unhandled',
        eventId: 'evt_1',
        type: 'video.upload.asset_created',
        passthrough: RECORDING_ID,
      },
    });
  });

  describe('video.asset.ready', () => {
    it('picks the SIGNED-policy playback id and ignores a public one', () => {
      const result = parseMuxWebhookEvent({
        id: 'evt_1',
        type: 'video.asset.ready',
        data: {
          passthrough: RECORDING_ID,
          id: ASSET_ID,
          duration: 125.6,
          playback_ids: [
            { id: 'pb_public', policy: 'public' },
            { id: 'pb_signed', policy: 'signed' },
          ],
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.event).toEqual({
        kind: 'video.asset.ready',
        eventId: 'evt_1',
        type: 'video.asset.ready',
        passthrough: RECORDING_ID,
        assetId: ASSET_ID,
        playbackId: 'pb_signed',
        durationSeconds: 126,
      });
    });

    it('⚠⚠ NO signed playback id ⇒ `playbackId: null` — the arm must refuse rather than half-stamp', () => {
      const result = parseMuxWebhookEvent({
        id: 'evt_1',
        type: 'video.asset.ready',
        data: { passthrough: RECORDING_ID, playback_ids: [{ id: 'pb_public', policy: 'public' }] },
      });

      expect(
        result.ok && result.event.kind === 'video.asset.ready' && result.event.playbackId
      ).toBeNull();
    });

    it('a missing `playback_ids` array ⇒ `playbackId: null`', () => {
      const result = parseMuxWebhookEvent({
        id: 'evt_1',
        type: 'video.asset.ready',
        data: { passthrough: RECORDING_ID },
      });

      expect(
        result.ok && result.event.kind === 'video.asset.ready' && result.event.playbackId
      ).toBeNull();
    });

    it('a non-numeric/negative duration ⇒ `durationSeconds: null`', () => {
      for (const duration of ['nonsense', -1, Number.POSITIVE_INFINITY, undefined]) {
        const result = parseMuxWebhookEvent({
          id: 'evt_1',
          type: 'video.asset.ready',
          data: { passthrough: RECORDING_ID, duration },
        });
        expect(
          result.ok && result.event.kind === 'video.asset.ready' && result.event.durationSeconds
        ).toBeNull();
      }
    });

    it('a missing `passthrough` and `id` ⇒ both null (the caller falls back to `assetId`)', () => {
      const result = parseMuxWebhookEvent({ id: 'evt_1', type: 'video.asset.ready', data: {} });

      expect(result.ok && result.event).toMatchObject({ passthrough: null, assetId: null });
    });

    /**
     * ⚠⚠ FIX ROUND 1 (F3) — a non-UUID `passthrough` degrades to `null` rather than reaching
     * `findById`, which binds it to a `uuid` column. Without this, ANY foreign passthrough (a
     * dashboard-created asset, a future feature in the same Mux environment) throws `22P02` as
     * an uncaught `500`, and the marker — written AFTER `resolveEffect` — never commits, so Mux
     * retries the SAME undying delivery forever and eventually disables the endpoint, taking
     * every genuine `video.asset.ready` delivery down with it.
     */
    it('⚠⚠ a non-UUID `passthrough` degrades to null — never reaches `findById` as a bad uuid', () => {
      const result = parseMuxWebhookEvent({
        id: 'evt_1',
        type: 'video.asset.ready',
        data: { passthrough: 'not-a-uuid', id: ASSET_ID },
      });

      expect(result.ok && result.event).toMatchObject({ passthrough: null, assetId: ASSET_ID });
    });
  });

  describe('video.asset.errored', () => {
    it('joins `data.errors.messages`', () => {
      const result = parseMuxWebhookEvent({
        id: 'evt_2',
        type: 'video.asset.errored',
        data: {
          passthrough: RECORDING_ID,
          id: ASSET_ID,
          errors: { messages: ['input file could not be read', 'transcode failed'] },
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.event).toEqual({
        kind: 'video.asset.errored',
        eventId: 'evt_2',
        type: 'video.asset.errored',
        passthrough: RECORDING_ID,
        assetId: ASSET_ID,
        errorMessage: 'input file could not be read; transcode failed',
      });
    });

    it('a missing `errors.messages` ⇒ `errorMessage: null`', () => {
      const result = parseMuxWebhookEvent({
        id: 'evt_2',
        type: 'video.asset.errored',
        data: { passthrough: RECORDING_ID },
      });

      expect(
        result.ok && result.event.kind === 'video.asset.errored' && result.event.errorMessage
      ).toBeNull();
    });
  });

  it('⚠ strips vendor fields this module has not named', () => {
    const result = parseMuxWebhookEvent({
      id: 'evt_1',
      type: 'video.asset.ready',
      environment: { name: 'production' },
      object: { type: 'asset', id: ASSET_ID },
      data: { passthrough: RECORDING_ID },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.event).sort((a, b) => a.localeCompare(b))).toEqual([
      'assetId',
      'durationSeconds',
      'eventId',
      'kind',
      'passthrough',
      'playbackId',
      'type',
    ]);
  });
});
