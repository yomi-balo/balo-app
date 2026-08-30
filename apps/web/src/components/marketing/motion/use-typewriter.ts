'use client';

import { useEffect, useState } from 'react';

/** Delay before the first character types, and the pause between erase → next phrase. */
const TYPE_START_DELAY_MS = 900;
const NEXT_PHRASE_DELAY_MS = 360;
/** How long a fully-typed phrase holds before it starts erasing. */
const HOLD_MS = 2000;
/** Per-character typing speed: a base plus jitter, so it doesn't read as a metronome. */
const TYPE_BASE_MS = 32;
const TYPE_JITTER_MS = 34;
const ERASE_MS = 14;

/**
 * BAL-493 §11 — the hero search's typewriter phrase cycle. Mirrors the design reference's
 * `useTypewriter` (`marketing-home.jsx:1275-1313`).
 *
 * Under reduced motion, returns `phrases[0]` statically (no caret, no cycling) — and does so
 * from the very first render, not just after an effect runs, since the initial `useState`
 * already resolves to it.
 */
export function useTypewriter(phrases: readonly string[], reduced: boolean): string {
  const [firstPhrase] = phrases;
  const [text, setText] = useState(reduced ? (firstPhrase ?? '') : '');

  useEffect(() => {
    if (reduced) {
      setText(firstPhrase ?? '');
      return undefined;
    }
    if (phrases.length === 0) return undefined;

    let phraseIndex = 0;
    let charIndex = 0;
    let deleting = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = (): void => {
      const phrase = phrases[phraseIndex] ?? '';
      if (deleting) {
        charIndex -= 1;
        setText(phrase.slice(0, charIndex));
        if (charIndex === 0) {
          deleting = false;
          phraseIndex = (phraseIndex + 1) % phrases.length;
          timer = setTimeout(tick, NEXT_PHRASE_DELAY_MS);
          return;
        }
        timer = setTimeout(tick, ERASE_MS);
      } else {
        charIndex += 1;
        setText(phrase.slice(0, charIndex));
        if (charIndex === phrase.length) {
          deleting = true;
          timer = setTimeout(tick, HOLD_MS);
          return;
        }
        timer = setTimeout(tick, TYPE_BASE_MS + Math.random() * TYPE_JITTER_MS);
      }
    };

    timer = setTimeout(tick, TYPE_START_DELAY_MS);
    return () => clearTimeout(timer);
  }, [phrases, reduced, firstPhrase]);

  return text;
}
