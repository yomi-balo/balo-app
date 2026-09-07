import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  redactSensitivePath,
  SENSITIVE_PATH_PREFIXES,
  STRIPE_SETUP_INTENT_RETURN_QUERY_PARAMS,
} from './index';
import * as asciiFold from './ascii-fold';

describe('redactSensitivePath', () => {
  it('redacts the token segment after a sensitive prefix', () => {
    expect(redactSensitivePath('/shared/proposals/abc123DEF')).toBe('/shared/proposals/[redacted]');
  });

  it('redacts inside a full URL and preserves the query string', () => {
    expect(redactSensitivePath('https://balo.expert/shared/proposals/tok_9f?ref=email')).toBe(
      'https://balo.expert/shared/proposals/[redacted]?ref=email'
    );
  });

  it('preserves a trailing path segment after the token', () => {
    expect(redactSensitivePath('/shared/proposals/tok/extra')).toBe(
      '/shared/proposals/[redacted]/extra'
    );
  });

  it('preserves a fragment after the token', () => {
    expect(redactSensitivePath('/shared/proposals/tok#section')).toBe(
      '/shared/proposals/[redacted]#section'
    );
  });

  it('leaves the bare prefix (no token) untouched', () => {
    expect(redactSensitivePath('/shared/proposals/')).toBe('/shared/proposals/');
  });

  it('does not match the prefix without its trailing slash', () => {
    expect(redactSensitivePath('/shared/proposals')).toBe('/shared/proposals');
  });

  it('passes normal paths through unchanged', () => {
    expect(redactSensitivePath('/dashboard')).toBe('/dashboard');
    expect(redactSensitivePath('/projects/123/proposal/456')).toBe('/projects/123/proposal/456');
    expect(redactSensitivePath('https://balo.expert/experts/dana')).toBe(
      'https://balo.expert/experts/dana'
    );
  });

  it('handles an empty string', () => {
    expect(redactSensitivePath('')).toBe('');
  });

  describe('BAL-390 — the review landing token', () => {
    it('redacts the token segment', () => {
      expect(redactSensitivePath('/review/abc123DEF')).toBe('/review/[redacted]');
    });

    it('preserves the ?r= prefill while redacting the token', () => {
      // The whole point of segment-only redaction: the emailed-star funnel stays
      // legible in Axiom/PostHog without the token ever being written down.
      expect(redactSensitivePath('/review/tok_9f?r=3')).toBe('/review/[redacted]?r=3');
    });

    it('redacts inside a full URL (the PostHog $current_url / $referrer shape)', () => {
      expect(redactSensitivePath('https://balo.expert/review/tok_9f?r=5')).toBe(
        'https://balo.expert/review/[redacted]?r=5'
      );
    });

    it('leaves the bare prefix (no token) untouched', () => {
      expect(redactSensitivePath('/review/')).toBe('/review/');
    });

    it('does not touch look-alike paths', () => {
      expect(redactSensitivePath('/review')).toBe('/review');
      expect(redactSensitivePath('/reviews/123')).toBe('/reviews/123');
      expect(redactSensitivePath('/engagements/123')).toBe('/engagements/123');
    });
  });

  describe('BAL-408 — the guest join landing token', () => {
    it('redacts the token segment', () => {
      expect(redactSensitivePath('/join/abc123DEF')).toBe('/join/[redacted]');
    });

    it('redacts inside a full URL (the PostHog $current_url / $referrer shape)', () => {
      expect(redactSensitivePath('https://balo.expert/join/tok_9f')).toBe(
        'https://balo.expert/join/[redacted]'
      );
    });

    /**
     * ⚠ The join token is NOT single-use — a guest presents it from desktop, then
     * phone, then again to rejoin after a network drop mid-call. A single logged
     * copy therefore stays replayable for the WHOLE 7-day window, which is why this
     * prefix is registered rather than treated as low-value telemetry.
     */
    it('redacts the token even when a trailing segment follows (a future sub-route)', () => {
      expect(redactSensitivePath('/join/tok_9f/lobby')).toBe('/join/[redacted]/lobby');
    });

    it('leaves the bare prefix (no token) untouched', () => {
      expect(redactSensitivePath('/join/')).toBe('/join/');
    });

    it('does not touch look-alike paths', () => {
      expect(redactSensitivePath('/join')).toBe('/join');
      expect(redactSensitivePath('/joins/123')).toBe('/joins/123');
      expect(redactSensitivePath('/onboarding/join-result')).toBe('/onboarding/join-result');
    });
  });

  /**
   * ── ⚠⚠ BAL-439 fix-round-1 / MUST-8 (security F3) — THE GUEST RECAP'S MEETING ID ──────────
   *
   * `/join/` redacts only the SINGLE segment following it — the token. Before this fix,
   * `/join/{token}/recap/{meetingId}` came out as `/join/[redacted]/recap/{meetingId}`: the
   * credential was protected but the meeting UUID sailed through into Axiom, Sentry and
   * PostHog's `$current_url`, from a page reachable by an unauthenticated guest. `/join/m/`
   * exists on this same list for the identical reason: "a meeting exists at this uuid" is
   * treated as non-disclosable to a third-party processor.
   */
  describe('BAL-439 — the guest recap meeting id', () => {
    const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';

    it('⚠⚠ redacts BOTH the token AND the meeting id', () => {
      expect(redactSensitivePath(`/join/tok_9f/recap/${MEETING_ID}`)).toBe(
        '/join/[redacted]/recap/[redacted]'
      );
    });

    it('⚠ the meeting id does not survive anywhere in the output', () => {
      const redacted = redactSensitivePath(`/join/tok_9f/recap/${MEETING_ID}`);
      expect(redacted).not.toContain(MEETING_ID);
    });

    it('preserves a trailing query string after the meeting id', () => {
      expect(redactSensitivePath(`/join/tok_9f/recap/${MEETING_ID}?ref=email`)).toBe(
        '/join/[redacted]/recap/[redacted]?ref=email'
      );
    });

    it('redacts inside a full URL (the PostHog $current_url / $referrer shape)', () => {
      expect(redactSensitivePath(`https://balo.expert/join/tok_9f/recap/${MEETING_ID}`)).toBe(
        `https://balo.expert/join/[redacted]/recap/[redacted]`
      );
    });

    it('⚠ a bare token with no /recap/ suffix is UNCHANGED by this chaining (regression guard)', () => {
      // The pre-existing "trailing segment" pin: `/join/tok_9f/lobby` must still redact ONLY
      // the token. This is the same code path — the chained redaction must not fire for a
      // trailing segment that is not literally `/recap/`.
      expect(redactSensitivePath('/join/tok_9f/lobby')).toBe('/join/[redacted]/lobby');
      expect(redactSensitivePath('/join/tok_9f')).toBe('/join/[redacted]');
    });

    it('leaves a bare /recap/ (no meeting id) untouched beyond the token', () => {
      expect(redactSensitivePath('/join/tok_9f/recap/')).toBe('/join/[redacted]/recap/');
    });
  });

  /**
   * ── ⚠⚠ BAL-132 — THE ANONYMOUS LOBBY, AND THE ORDERING BUG IT EXPOSED ────────────────────
   *
   * `redactSensitivePath` replaces only THE SINGLE SEGMENT following a prefix and returns on
   * the FIRST prefix that matches. `/join/` matches `/join/m/{id}`, and the segment after it
   * is the literal `m` — so with `/join/` alone the output was `/join/[redacted]/{id}` and the
   * meeting id sailed through to Axiom, Sentry and PostHog's `$current_url`, from an anonymous
   * browser on a public page. A docblock on the route claimed coverage "verified, not
   * assumed"; it was neither. `/join/m/` is now registered AHEAD of `/join/`.
   */
  describe('BAL-132 — the anonymous lobby meeting id', () => {
    it('⚠⚠ redacts the MEETING ID, not the literal segment `m`', () => {
      expect(redactSensitivePath('/join/m/0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d')).toBe(
        '/join/m/[redacted]'
      );
    });

    it('⚠ THE ORDER IS THE FIX — the more specific prefix must win', () => {
      // A regression here reads as `/join/[redacted]/…`, i.e. the id preserved verbatim. This
      // asserts the failure SHAPE explicitly so a reordering cannot pass by accident.
      const redacted = redactSensitivePath('/join/m/0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d');
      expect(redacted).not.toContain('0f7b1c2d');
      expect(redacted).not.toBe('/join/[redacted]/0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d');
    });

    it('redacts inside a full URL (the PostHog $current_url shape) and keeps the query', () => {
      expect(redactSensitivePath('https://balo.expert/join/m/abc-123?utm=x')).toBe(
        'https://balo.expert/join/m/[redacted]?utm=x'
      );
    });

    it('redacts the percent-encoded form too (the ?from=%2Fjoin%2Fm%2F… trap)', () => {
      expect(redactSensitivePath('/onboarding?forced=1&from=%2Fjoin%2Fm%2Fabc-123')).toBe(
        '/onboarding?forced=1&from=%2Fjoin%2Fm%2F[redacted]'
      );
    });

    it('⚠ does NOT change how a guest TOKEN is redacted — tokens contain no slash', () => {
      // `/join/m/` cannot occur inside a base64url token, so the token arm is untouched.
      expect(redactSensitivePath('/join/mABC123def')).toBe('/join/[redacted]');
      expect(redactSensitivePath('/join/tok_9f/lobby')).toBe('/join/[redacted]/lobby');
    });

    it('leaves the bare lobby prefix (no id) untouched', () => {
      expect(redactSensitivePath('/join/m/')).toBe('/join/m/');
    });
  });

  /**
   * ⚠ THE ENCODE-THEN-MISS TRAP. A sensitive path does not only travel as a path: the
   * fail-closed onboarding gate in `apps/web/src/middleware.ts` stashes the origin
   * pathname as a QUERY VALUE, and `URLSearchParams` percent-encodes the slashes. A
   * literal `indexOf('/join/')` returns -1 against `%2Fjoin%2F…`, the redaction silently
   * no-ops, and the raw token reaches the `Location:` header, the Axiom line and — once
   * the wizard reads `?from=` back and hands it to `track()` — a plain PostHog property.
   *
   * All three prefixes share the mechanism, so all three are pinned here.
   */
  describe('percent-encoded prefixes (the ?from=%2Fjoin%2F{token} trap)', () => {
    const ENCODED_CASES = [
      { label: 'BAL-408 /join/', encodedPrefix: '%2Fjoin%2F' },
      { label: 'BAL-390 /review/', encodedPrefix: '%2Freview%2F' },
      { label: 'BAL-386 /shared/proposals/', encodedPrefix: '%2Fshared%2Fproposals%2F' },
    ] as const;

    for (const { label, encodedPrefix } of ENCODED_CASES) {
      it(`redacts the encoded form for ${label}`, () => {
        expect(redactSensitivePath(`/onboarding?forced=1&from=${encodedPrefix}tok_9f`)).toBe(
          `/onboarding?forced=1&from=${encodedPrefix}[redacted]`
        );
      });

      it(`stops the encoded redaction at the next query parameter for ${label}`, () => {
        expect(redactSensitivePath(`/onboarding?from=${encodedPrefix}tok_9f&forced=1`)).toBe(
          `/onboarding?from=${encodedPrefix}[redacted]&forced=1`
        );
      });

      it(`redacts the lowercase-hex encoded form for ${label}`, () => {
        const lower = encodedPrefix.replaceAll('%2F', '%2f');
        expect(redactSensitivePath(`/onboarding?from=${lower}tok_9f`)).toBe(
          `/onboarding?from=${lower}[redacted]`
        );
      });

      it(`leaves the bare encoded prefix (no token) untouched for ${label}`, () => {
        const value = `/onboarding?from=${encodedPrefix}`;
        expect(redactSensitivePath(value)).toBe(value);
      });
    }

    it('stops at an encoded trailing delimiter rather than swallowing the rest', () => {
      // `%2Flobby` is an encoded `/lobby` sub-route — the token ends before it.
      expect(redactSensitivePath('/onboarding?from=%2Fjoin%2Ftok_9f%2Flobby')).toBe(
        '/onboarding?from=%2Fjoin%2F[redacted]%2Flobby'
      );
    });

    it('redacts the encoded form inside a full absolute URL (the $referrer shape)', () => {
      expect(
        redactSensitivePath('https://balo.expert/onboarding?forced=1&from=%2Fjoin%2Ftok_9f')
      ).toBe('https://balo.expert/onboarding?forced=1&from=%2Fjoin%2F[redacted]');
    });

    it('does not touch encoded look-alikes', () => {
      expect(redactSensitivePath('/onboarding?from=%2Fjoins%2F123')).toBe(
        '/onboarding?from=%2Fjoins%2F123'
      );
      expect(redactSensitivePath('/onboarding?from=%2Fdashboard')).toBe(
        '/onboarding?from=%2Fdashboard'
      );
    });

    it('still prefers the literal prefix when both forms are present', () => {
      expect(redactSensitivePath('/join/rawtok?from=%2Freview%2Fenctok')).toBe(
        '/join/[redacted]?from=%2Freview%2Fenctok'
      );
    });
  });

  /**
   * ⚠ THE VARIANTS A TWO-LITERAL LIST MISSES. Generating only `%2F` and `%2f` per prefix
   * leaves two gaps that no encoder is obliged to avoid: MIXED case inside one prefix, and
   * DOUBLE encoding. Neither is reachable through a shipped Balo flow — `redirectToOnboarding`
   * redacts the raw pathname before `URLSearchParams` ever encodes it — so these pin defence
   * in depth against a future or third-party producer, the class of caller that will never be
   * reviewed against `redaction/index.ts`.
   */
  describe('encoding variants (defence in depth)', () => {
    const MIXED_CASE_CASES = [
      { label: '/join/', value: '%2Fjoin%2f' },
      { label: '/review/', value: '%2freview%2F' },
      { label: '/shared/proposals/', value: '%2Fshared%2fproposals%2F' },
    ] as const;

    for (const { label, value } of MIXED_CASE_CASES) {
      it(`redacts a MIXED-case encoded prefix for ${label}`, () => {
        expect(redactSensitivePath(`/onboarding?from=${value}tok_9f`)).toBe(
          `/onboarding?from=${value}[redacted]`
        );
      });
    }

    it('preserves the original hex casing rather than normalising it', () => {
      // The fold exists only to FIND the prefix; the output must be the caller's own bytes,
      // otherwise a redacted line stops matching the un-redacted ones around it.
      expect(redactSensitivePath('/onboarding?from=%2FJoin%2ftok')).toBe(
        '/onboarding?from=%2FJoin%2f[redacted]'
      );
    });

    const DOUBLE_ENCODED_CASES = [
      { label: '/join/', value: '%252Fjoin%252F' },
      { label: '/review/', value: '%252freview%252f' },
      { label: '/shared/proposals/', value: '%252Fshared%252Fproposals%252F' },
    ] as const;

    for (const { label, value } of DOUBLE_ENCODED_CASES) {
      it(`redacts a DOUBLE-encoded prefix for ${label}`, () => {
        expect(redactSensitivePath(`/onboarding?from=${value}tok_9f`)).toBe(
          `/onboarding?from=${value}[redacted]`
        );
      });
    }

    it('stops a double-encoded token at the next encoded delimiter', () => {
      expect(redactSensitivePath('/onboarding?from=%252Fjoin%252Ftok_9f%252Flobby')).toBe(
        '/onboarding?from=%252Fjoin%252F[redacted]%252Flobby'
      );
    });

    it('leaves the bare double-encoded prefix (no token) untouched', () => {
      const value = '/onboarding?from=%252Fjoin%252F';
      expect(redactSensitivePath(value)).toBe(value);
    });

    it('does not confuse a single-encoded look-alike with the double-encoded form', () => {
      expect(redactSensitivePath('/onboarding?from=%252Fjoins%252F123')).toBe(
        '/onboarding?from=%252Fjoins%252F123'
      );
    });

    /**
     * The fold is A–Z only precisely so this holds: `toLowerCase()` would turn `İ` into two
     * code units, desynchronising every index after it and slicing the redaction into the
     * wrong place.
     */
    it('does not corrupt a value carrying non-ASCII text alongside an encoded prefix', () => {
      expect(redactSensitivePath('/onboarding?name=İstanbul&from=%2Fjoin%2Ftok_9f')).toBe(
        '/onboarding?name=İstanbul&from=%2Fjoin%2F[redacted]'
      );
    });

    it('leaves non-ASCII untouched on the literal path too', () => {
      expect(redactSensitivePath('/join/tok_9f?city=İstanbul')).toBe(
        '/join/[redacted]?city=İstanbul'
      );
    });
  });

  /**
   * ⚠ IDEMPOTENCE IS RELIED ON, not incidental. The Sentry scrubbers run this over fields
   * that a global event processor may already have redacted (a replay event passes through
   * `prepareEvent`'s processors AND the scrubbing hooks), so a second pass must be a no-op.
   */
  describe('idempotence', () => {
    const ALREADY_REDACTED = [
      '/join/[redacted]',
      // BAL-439 fix-round-1 / MUST-8 — the chained guest-recap meeting-id redaction.
      '/join/[redacted]/recap/[redacted]',
      '/review/[redacted]?r=3',
      '/shared/proposals/[redacted]/extra',
      '/onboarding?from=%2Fjoin%2F[redacted]',
    ];

    for (const value of ALREADY_REDACTED) {
      it(`re-redacting ${value} changes nothing`, () => {
        expect(redactSensitivePath(value)).toBe(value);
      });
    }
  });
});

// ── BAL-494 fix round 2: the switch token in a QUERY VALUE ──────────────────

describe('redactSensitivePath — sensitive query parameters', () => {
  const SEALED = 'Fe26.2**abc123DEF456ghi789JKL**mno**pqr-stu_vwx**yz';

  it('redacts the sealed switch token from the route URL', () => {
    expect(redactSensitivePath(`/api/auth/switch-workspace?t=${SEALED}`)).toBe(
      '/api/auth/switch-workspace?t=[redacted]'
    );
  });

  it('preserves returnTo — only the credential is stripped', () => {
    expect(
      redactSensitivePath(`/api/auth/switch-workspace?t=${SEALED}&returnTo=%2Fprojects%2Freq-1`)
    ).toBe('/api/auth/switch-workspace?t=[redacted]&returnTo=%2Fprojects%2Freq-1');
  });

  it('redacts the token when it is NOT the first parameter', () => {
    expect(
      redactSensitivePath(`/api/auth/switch-workspace?returnTo=%2Fdashboard&t=${SEALED}`)
    ).toBe('/api/auth/switch-workspace?returnTo=%2Fdashboard&t=[redacted]');
  });

  it('redacts inside a full URL (the Sentry `request.url` shape)', () => {
    expect(redactSensitivePath(`https://balo.expert/api/auth/switch-workspace?t=${SEALED}`)).toBe(
      'https://balo.expert/api/auth/switch-workspace?t=[redacted]'
    );
  });

  it('stops at the fragment', () => {
    expect(redactSensitivePath(`/api/auth/switch-workspace?t=${SEALED}#top`)).toBe(
      '/api/auth/switch-workspace?t=[redacted]#top'
    );
  });

  it('leaves a `t` parameter on ANY OTHER path completely alone', () => {
    // The registry is path-scoped on purpose: `?t=` is a common, innocuous parameter name.
    expect(redactSensitivePath('/dashboard?t=1234')).toBe('/dashboard?t=1234');
    expect(redactSensitivePath('/experts?q=salesforce&t=table')).toBe(
      '/experts?q=salesforce&t=table'
    );
  });

  it('does not touch a longer parameter that merely ENDS in t', () => {
    expect(redactSensitivePath('/api/auth/switch-workspace?at=keep-me')).toBe(
      '/api/auth/switch-workspace?at=keep-me'
    );
  });

  it('tolerates the parameter being present but empty', () => {
    expect(redactSensitivePath('/api/auth/switch-workspace?t=&returnTo=%2Fx')).toBe(
      '/api/auth/switch-workspace?t=&returnTo=%2Fx'
    );
  });

  it('is idempotent', () => {
    const once = redactSensitivePath(`/api/auth/switch-workspace?t=${SEALED}`);
    expect(redactSensitivePath(once)).toBe(once);
  });

  it('leaves the route URL untouched when it carries no token at all', () => {
    expect(redactSensitivePath('/api/auth/switch-workspace')).toBe('/api/auth/switch-workspace');
  });

  it('still redacts a PATH secret on a URL that also carries a scoped query secret', () => {
    // The two passes are independent — neither suppresses the other.
    expect(redactSensitivePath(`/join/guest-token-abc?next=%2Fapi%2Fauth%2Fswitch-workspace`)).toBe(
      '/join/[redacted]?next=%2Fapi%2Fauth%2Fswitch-workspace'
    );
  });
});

// ── BAL-529 §B: the Stripe redirect-return params, PATH-INDEPENDENT ─────────

describe('redactSensitivePath — Stripe redirect-return params (BAL-529 §B)', () => {
  it('redacts setup_intent and setup_intent_client_secret on /settings/billing', () => {
    expect(
      redactSensitivePath(
        '/settings/billing?setup_intent=seti_abc123&setup_intent_client_secret=seti_abc123_secret_XYZ'
      )
    ).toBe('/settings/billing?setup_intent=[redacted]&setup_intent_client_secret=[redacted]');
  });

  it('redacts them on /redeem', () => {
    expect(
      redactSensitivePath(
        '/redeem?setup_intent=seti_def456&setup_intent_client_secret=seti_def456_secret_XYZ'
      )
    ).toBe('/redeem?setup_intent=[redacted]&setup_intent_client_secret=[redacted]');
  });

  it('redacts them on a path in NO registry (/billing/top-up) — these params are path-independent', () => {
    // ⚠ THE DESIGN DECISION ITSELF. A `pathMarker`-scoped registry (the ticket's suggested
    // shape) would leave this path uncovered — and §G's `confirmSetup`/`confirmPayment`
    // return here today.
    expect(
      redactSensitivePath('/billing/top-up?setup_intent=seti_ghi789&redirect_status=succeeded')
    ).toBe('/billing/top-up?setup_intent=[redacted]&redirect_status=[redacted]');
  });

  it('redacts redirect_status too', () => {
    expect(redactSensitivePath('/settings/billing?redirect_status=failed')).toBe(
      '/settings/billing?redirect_status=[redacted]'
    );
  });

  it('redacts payment_intent + payment_intent_client_secret (the confirmPayment 3DS return)', () => {
    expect(
      redactSensitivePath(
        '/billing/top-up?payment_intent=pi_abc123&payment_intent_client_secret=pi_abc123_secret_XYZ'
      )
    ).toBe('/billing/top-up?payment_intent=[redacted]&payment_intent_client_secret=[redacted]');
  });

  it('redacts BOTH setup_intent and setup_intent_client_secret when both are present, in either query order', () => {
    // The prefix-collision hazard: `setup_intent=` must not falsely match inside
    // `setup_intent_client_secret=`, and vice versa.
    expect(
      redactSensitivePath(
        '/settings/billing?setup_intent_client_secret=seti_xyz_secret&setup_intent=seti_xyz'
      )
    ).toBe('/settings/billing?setup_intent_client_secret=[redacted]&setup_intent=[redacted]');
  });

  it('preserves an unrelated param alongside them', () => {
    expect(redactSensitivePath('/settings/billing?tab=cards&setup_intent=seti_abc123')).toBe(
      '/settings/billing?tab=cards&setup_intent=[redacted]'
    );
  });

  it('is idempotent', () => {
    const once = redactSensitivePath(
      '/settings/billing?setup_intent=seti_abc123&setup_intent_client_secret=seti_abc123_secret'
    );
    expect(redactSensitivePath(once)).toBe(once);
  });

  it('still redacts a PATH secret on a URL that also carries a Stripe param', () => {
    expect(redactSensitivePath('/join/guest-token-abc?setup_intent=seti_abc123')).toBe(
      '/join/[redacted]?setup_intent=[redacted]'
    );
  });

  it('STRIPE_SETUP_INTENT_RETURN_QUERY_PARAMS lists exactly the three, in order', () => {
    expect(STRIPE_SETUP_INTENT_RETURN_QUERY_PARAMS).toEqual([
      'setup_intent',
      'setup_intent_client_secret',
      'redirect_status',
    ]);
  });
});

// ── BAL-529 fix-round-1 F1 (security S2 / review CRITICAL-1): EVERY occurrence, not just the
// first. Empirically confirmed against the shipped (pre-fix) code that a duplicated pair left
// the SECOND occurrence — the GENUINE one on the A2 return_url-poisoning shape, since Stripe
// appends its own pair AFTER an attacker's — completely unredacted. ────────────────────────

describe('redactSensitivePath — BAL-529 fix-round-1 F1 (every occurrence of a duplicated param)', () => {
  it('⚠⚠ the exact A2 return_url-poisoning shape: the LIVE secret does not survive', () => {
    const value =
      '/settings/billing?setup_intent=seti_evil&setup_intent_client_secret=seti_evil_secret' +
      '&setup_intent=seti_real&setup_intent_client_secret=seti_real_secret_LIVE';

    const redacted = redactSensitivePath(value);

    expect(redacted).toBe(
      '/settings/billing?setup_intent=[redacted]&setup_intent_client_secret=[redacted]' +
        '&setup_intent=[redacted]&setup_intent_client_secret=[redacted]'
    );
    // Belt-and-braces on the actual claim the finding makes: no raw value anywhere in the output.
    expect(redacted).not.toContain('seti_evil');
    expect(redacted).not.toContain('seti_real');
    expect(redacted).not.toContain('LIVE');
  });

  it('redacts THREE occurrences of the same param, not just the first', () => {
    expect(
      redactSensitivePath('/settings/billing?setup_intent=a&setup_intent=b&setup_intent=c')
    ).toBe(
      '/settings/billing?setup_intent=[redacted]&setup_intent=[redacted]&setup_intent=[redacted]'
    );
  });

  it('a LEADING unrelated param does not shield a later duplicate occurrence', () => {
    // Pre-fix, the `?`-lead scan only ever matches at the very start of the query string, so a
    // leading unrelated param meant the `?setup_intent=` shape never matched at all and ONLY the
    // `&`-led occurrence(s) were found — still just the first of those.
    expect(redactSensitivePath('/settings/billing?tab=x&setup_intent=a&setup_intent=b')).toBe(
      '/settings/billing?tab=x&setup_intent=[redacted]&setup_intent=[redacted]'
    );
  });

  it('the scoped SENSITIVE_QUERY_PARAMS (?t=) pass has the identical fix', () => {
    const SEALED_1 = 'Fe26.2**aaa**bbb**ccc';
    const SEALED_2 = 'Fe26.2**ddd**eee**fff';
    // Both occurrences deliberately share the `&` lead (rather than one `?`-led + one `&`-led)
    // so this actually exercises the loop: a single-scan-per-lead implementation would still
    // redact one `?t=` and one `&t=` occurrence by accident even without the fix.
    expect(redactSensitivePath(`/api/auth/switch-workspace?x=1&t=${SEALED_1}&t=${SEALED_2}`)).toBe(
      '/api/auth/switch-workspace?x=1&t=[redacted]&t=[redacted]'
    );
  });

  it('a duplicated payment_intent pair (the confirmPayment twin) is fully redacted too', () => {
    // Both occurrences share the `&` lead — see the `?t=` test above for why that matters to
    // actually exercise the loop rather than passing by accident.
    expect(
      redactSensitivePath('/billing/top-up?x=1&payment_intent=pi_evil&payment_intent=pi_real_LIVE')
    ).toBe('/billing/top-up?x=1&payment_intent=[redacted]&payment_intent=[redacted]');
  });

  it('is idempotent over a duplicated-pair value', () => {
    const once = redactSensitivePath(
      '/settings/billing?setup_intent=a&setup_intent=b&setup_intent=c'
    );
    expect(redactSensitivePath(once)).toBe(once);
  });
});

// ── BAL-529 fix-round-1 F8 (security S5 + S6): case-fold, percent-encoding and fragment
// defences on the path-independent Stripe/PaymentIntent query-param registry only. ──────────

describe('redactSensitivePath — BAL-529 fix-round-1 F8 (case-fold, %5f, fragment)', () => {
  it('redacts an UPPERCASE param name', () => {
    expect(redactSensitivePath('/settings/billing?SETUP_INTENT=seti_abc123')).toBe(
      '/settings/billing?SETUP_INTENT=[redacted]'
    );
  });

  it('redacts a MIXED-case param name', () => {
    expect(redactSensitivePath('/settings/billing?Setup_Intent=seti_abc123')).toBe(
      '/settings/billing?Setup_Intent=[redacted]'
    );
  });

  it('redacts the percent-encoded-underscore form of the param name (?setup%5Fintent=)', () => {
    expect(redactSensitivePath('/settings/billing?setup%5Fintent=seti_abc123')).toBe(
      '/settings/billing?setup%5Fintent=[redacted]'
    );
  });

  it('redacts the lowercase-hex percent-encoded-underscore form too (?setup%5fintent=)', () => {
    expect(redactSensitivePath('/settings/billing?setup%5fintent=seti_abc123')).toBe(
      '/settings/billing?setup%5fintent=[redacted]'
    );
  });

  it('redacts a fragment-carried param — $current_url includes the fragment', () => {
    expect(redactSensitivePath('/settings/billing#setup_intent=seti_abc123')).toBe(
      '/settings/billing#setup_intent=[redacted]'
    );
  });

  it('redacts a fragment-carried param on a full URL', () => {
    expect(redactSensitivePath('https://balo.expert/redeem#setup_intent=seti_abc123')).toBe(
      'https://balo.expert/redeem#setup_intent=[redacted]'
    );
  });

  it('does NOT extend the fragment lead to the pathMarker-scoped switch-token pass', () => {
    const value = '/api/auth/switch-workspace#t=Fe26.2**abc';
    expect(redactSensitivePath(value)).toBe(value);
  });

  it('combines case-fold with the duplicate-occurrence fix (F1 + F8 together)', () => {
    expect(redactSensitivePath('/settings/billing?SETUP_INTENT=a&setup_intent=b')).toBe(
      '/settings/billing?SETUP_INTENT=[redacted]&setup_intent=[redacted]'
    );
  });

  it('is idempotent over an uppercase param name', () => {
    const once = redactSensitivePath('/settings/billing?SETUP_INTENT=seti_abc123');
    expect(redactSensitivePath(once)).toBe(once);
  });
});

describe('SENSITIVE_PATH_PREFIXES', () => {
  it('lists exactly the four registered landings', () => {
    expect([...SENSITIVE_PATH_PREFIXES].sort((a, b) => a.localeCompare(b))).toEqual([
      '/join/',
      '/join/m/',
      '/review/',
      '/shared/proposals/',
    ]);
  });

  it('every prefix ends in a slash so a look-alike route cannot match', () => {
    for (const prefix of SENSITIVE_PATH_PREFIXES) {
      expect(prefix.startsWith('/')).toBe(true);
      expect(prefix.endsWith('/')).toBe(true);
    }
  });

  /**
   * ⚠⚠ THE DECLARATION ORDER IS PART OF THE CONTRACT, NOT A STYLE CHOICE.
   * `redactSensitivePath` returns on the first prefix that matches, so a prefix that is a
   * STRING EXTENSION of another must be declared before it — otherwise the shorter one wins
   * and redacts the wrong segment. `/join/m/` vs `/join/` is the live instance; this asserts
   * the RULE, so a future `/review/x/` gets it for free.
   */
  it('⚠ any prefix that extends another is declared BEFORE it (first match wins)', () => {
    SENSITIVE_PATH_PREFIXES.forEach((prefix, index) => {
      const extended = SENSITIVE_PATH_PREFIXES.filter(
        (other) => other !== prefix && other.startsWith(prefix)
      );
      for (const specific of extended) {
        expect(
          SENSITIVE_PATH_PREFIXES.indexOf(specific),
          `${specific} must be declared before ${prefix}`
        ).toBeLessThan(index);
      }
    });
  });
});

// ── FIX ROUND 2 G1: the F1 (fixpoint loop) + F8 (case-fold) combination made the
// case-folded query-param pass O(occurrences × length) — quadratic — because the fold was
// recomputed from scratch on EVERY iteration of the occurrence loop, over the WHOLE haystack.
// `apps/web/src/middleware.ts:27` calls `redactSensitivePath` on the bare pathname for the
// request log BEFORE any auth check (`&` is a legal path character), so this was an
// unauthenticated CPU-burn vector on Edge. ──────────────────────────────────────────────────

describe('redactSensitivePath — FIX ROUND 2 G1 (no O(n²) re-fold on the case-folded pass)', () => {
  let foldSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    foldSpy = vi.spyOn(asciiFold, 'toAsciiLowerCase');
  });

  afterEach(() => {
    foldSpy.mockRestore();
  });

  /**
   * ⚠⚠ THE CALL-COUNT ASSERTION, PREFERRED OVER A WALL-CLOCK BOUND — deterministic and immune
   * to a loaded CI box, unlike a timing assertion. Exercises the ORCHESTRATOR'S OWN measured
   * shape: a bare PATHNAME (no scheme, no host) with the Stripe param repeated many times —
   * exactly `middleware.ts:27`'s pre-auth argument.
   *
   * Before the G1 fix, `redactAllAfterPrefix` called `toAsciiLowerCase` once per OCCURRENCE
   * found (500 here, not counting the final non-matching probe) — this assertion would have
   * read `toHaveBeenCalledTimes(501)` or worse pre-fix; after the fix it is called exactly
   * ONCE per `redactSensitivePath` call, independent of occurrence count.
   */
  it('folds the case-fold haystack ONCE, independent of occurrence count (~500 occurrences)', () => {
    const manyOccurrences = '/a' + '&setup_intent='.repeat(500);

    foldSpy.mockClear();
    redactSensitivePath(manyOccurrences);

    expect(foldSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * THE "SECONDARY" G1 finding: even a URL carrying NONE of the five path-independent Stripe
   * params used to pay up to 30 full-string folds (5 params × 3 leads × 2 encoded forms) for
   * nothing, because each of the 30 `redactAllAfterPrefix` calls folded `result` again from
   * scratch. `redactSensitiveQueryParams` now folds once and threads the result through all 30.
   */
  it('folds the haystack ONCE even when the URL carries none of the Stripe params', () => {
    foldSpy.mockClear();
    redactSensitivePath('/dashboard');

    expect(foldSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * Correctness, not just call count: the hoist-and-splice approach must still produce the
   * SAME output a full re-fold would have. Unlike the two tests above, these occurrences carry
   * a real one-character value (`x`) so the splice path (`tokenEnd > tokenStart`) is actually
   * exercised on every one of the 50 occurrences, not just the bare-prefix advance.
   */
  it('still redacts EVERY occurrence correctly with the hoisted, spliced fold', () => {
    const value = '/a' + '&setup_intent=x'.repeat(50);

    const redacted = redactSensitivePath(value);

    expect(redacted).not.toContain('setup_intent=x');
    expect((redacted.match(/\[redacted\]/g) ?? []).length).toBe(50);
  });
});
