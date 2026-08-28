import { describe, it, expect } from 'vitest';
import { redactSensitivePath, SENSITIVE_PATH_PREFIXES } from './index';

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
