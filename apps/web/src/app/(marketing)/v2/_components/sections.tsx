/**
 * BAL-510 — the /v2 page sections below the hero, ported verbatim from the design ref
 * (ref :1131-1442): `Contrast`, `Ways`, `Steps`, `Spotlight`, `Pricing`, `Quote`, `Band`,
 * `Final`, `Footer`. Static JSX + the ref's sample data (`_lib/content.ts`) — no hooks of
 * their own beyond `Group`'s IntersectionObserver (`_components/motion.tsx`).
 *
 * CTA destinations follow the technical plan's Route/CTA wiring table (as amended by
 * `.handoff/build-rulings.md`), not the ref's placeholder `#top` / `href`-less buttons.
 * In-page anchors that ARE genuine navigation within this page stay plain `<a>` tags;
 * everything that resolves to a real route is a `next/link` `Link` with
 * `prefetch={false}` (this page has ~44 `/experts`-bound links — see the plan for why).
 */

import type { CSSProperties } from 'react';
import Link from 'next/link';
import {
  avatarGradient,
  EXPERTS,
  FOOTER_LINKS,
  initials,
  QUOTE,
  STEPS,
  WAYS,
} from '../_lib/content';
import { I } from './icons';
import { Group } from './motion';

/**
 * `style={{ '--i': i }}` — TS rejects custom properties on `CSSProperties` directly, so
 * every reveal-staggered element in this file goes through this one helper/cast rather
 * than scattering `as` casts (technical plan, component note A1).
 */
function revealStyle(i: number, extra?: CSSProperties): CSSProperties {
  return { '--i': i, ...extra } as CSSProperties;
}

// ─────────────────────────────────────────────────────────────────
// CONTRAST — the Viktor device, rebuilt for consulting procurement
// (Timeline days are illustrative placeholders, per the ref.)
// ─────────────────────────────────────────────────────────────────
export function Contrast(): React.JSX.Element {
  return (
    <Group className="mk2-sec mk2-center mk2-tint-blue" id="difference">
      <div className="mk2-wrap">
        <span className="mk2-kicker mk2-reveal">The difference</span>
        <h2 className="mk2-h2 mk2-reveal" style={revealStyle(1)}>
          An agency scopes.
          <br />
          Balo solves.
        </h2>
        <p className="mk2-line mk2-reveal" style={revealStyle(2)}>
          Same calibre of expert. None of the ceremony.
        </p>

        <div className="mk2-vs">
          <div className="mk2-vs-card mk2-vs-old mk2-reveal" style={revealStyle(3)}>
            <div className="mk2-vs-label">The old way</div>
            <div className="mk2-vs-row">
              <span className="mk2-vs-when mk2-mono">Day 1</span>Discovery call
            </div>
            <div className="mk2-vs-row">
              <span className="mk2-vs-when mk2-mono">Day 9</span>Proposal
            </div>
            <div className="mk2-vs-row">
              <span className="mk2-vs-when mk2-mono">Day 23</span>SOW signed
            </div>
            <div className="mk2-vs-row">
              <span className="mk2-vs-when mk2-mono">Week 6</span>Kickoff
            </div>
            <div className="mk2-vs-foot mk2-mono">Invoice: TBD</div>
          </div>
          <div className="mk2-vs-card mk2-vs-balo mk2-reveal" style={revealStyle(4)}>
            <div className="mk2-vs-label">With Balo</div>
            <div className="mk2-vs-row">
              <span className="mk2-vs-when mk2-mono">2:14 pm</span>Booked
            </div>
            <div className="mk2-vs-row">
              <span className="mk2-vs-when mk2-mono">2:30 pm</span>On the call
            </div>
            <div className="mk2-vs-row">
              <span className="mk2-vs-when mk2-mono">2:53 pm</span>Fixed
              <span className="mk2-vs-check">
                <I.check size={15} />
              </span>
            </div>
            <div className="mk2-vs-foot mk2-mono">23 min · A$55.20 · Service fee included</div>
          </div>
        </div>
      </div>
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────
// WAYS — three engagement types as a typographic ledger
// Row 4 of the wiring table: genuine in-page anchors, unchanged.
// ─────────────────────────────────────────────────────────────────
export function Ways(): React.JSX.Element {
  return (
    <Group className="mk2-sec-tight mk2-center" id="ways">
      <div className="mk2-wrap">
        <span className="mk2-kicker mk2-reveal">Three ways in</span>
        <h2 className="mk2-h2 mk2-reveal" style={revealStyle(1)}>
          Small question or six-week build.
        </h2>
        <div className="mk2-ways mk2-reveal" style={revealStyle(2, { textAlign: 'left' })}>
          {WAYS.map((w) => (
            <a key={w.name} className="mk2-way" href={w.href}>
              <span className="mk2-way-name">{w.name}</span>
              <span className="mk2-way-desc">
                {w.desc}
                <br />
                <span className="mk2-mono">{w.tag}</span>
              </span>
              <span className="mk2-way-arrow">
                <I.arrowPlain size={20} />
              </span>
            </a>
          ))}
        </div>
      </div>
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────
// STEPS — a real sequence, so the numbers mean something
// ─────────────────────────────────────────────────────────────────
export function Steps(): React.JSX.Element {
  return (
    <Group className="mk2-sec mk2-center mk2-tint-violet" id="how">
      <div className="mk2-wrap">
        <span className="mk2-kicker mk2-reveal">How it works</span>
        <h2 className="mk2-h2 mk2-reveal" style={revealStyle(1)}>
          Stuck to fixed, in three moves.
        </h2>
        <div className="mk2-steps">
          {STEPS.map((s, i) => (
            <div key={s.num} className="mk2-step mk2-reveal" style={revealStyle(i + 2)}>
              <span className="mk2-step-num">{s.num}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────
// SPOTLIGHT — real experts in production (BAL-493); minimal cards here are
// visual stand-ins. Rows 5-7 of the wiring table: "Book a call" and
// "View profile" become `Link`s to `/experts` (`<button>` → `<a>` for "Book a
// call" — `.mk2-xc-book` sets display/height/padding/radius/`border:none`, so
// the rendered box is unchanged); "Browse all experts" likewise.
// ─────────────────────────────────────────────────────────────────
export function Spotlight(): React.JSX.Element {
  return (
    <Group className="mk2-sec-tight mk2-center" id="experts">
      <div className="mk2-wrap">
        <span className="mk2-kicker mk2-reveal">The bench</span>
        <h2 className="mk2-h2 mk2-reveal" style={revealStyle(1)}>
          A few of the top 1%.
        </h2>
        <div className="mk2-experts">
          {EXPERTS.map((e, i) => (
            <div key={e.id} className="mk2-xc mk2-reveal" style={revealStyle(i + 2)}>
              <div className="mk2-xc-top">
                <span className="mk2-xc-av" style={{ background: avatarGradient(e.id) }}>
                  {initials(e.n)}
                  <span className="mk2-xc-avdot" />
                </span>
                <div>
                  <div className="mk2-xc-name">{e.n}</div>
                  <div className="mk2-xc-spec">{e.s}</div>
                </div>
              </div>
              <div className="mk2-xc-rate mk2-mono">
                A${e.r.toFixed(2)}/min<small>all-in</small>
              </div>
              <div className="mk2-xc-foot">
                <Link className="mk2-xc-book" href="/experts" prefetch={false}>
                  <I.video size={14} />
                  Book a call
                </Link>
                <Link className="mk2-xc-profile" href="/experts" prefetch={false}>
                  View profile
                </Link>
              </div>
            </div>
          ))}
        </div>
        <Link
          className="mk2-browse mk2-reveal"
          style={revealStyle(5)}
          href="/experts"
          prefetch={false}
        >
          Browse all experts
          <I.arrowPlain size={16} />
        </Link>
      </div>
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────
// PRICING — one sentence and a receipt
// ─────────────────────────────────────────────────────────────────
export function Pricing(): React.JSX.Element {
  return (
    <Group className="mk2-sec mk2-center" id="pricing">
      <div className="mk2-wrap">
        <span className="mk2-kicker mk2-reveal">Pricing</span>
        <h2 className="mk2-h2 mk2-reveal" style={revealStyle(1)}>
          One all-in rate.
        </h2>
        <p className="mk2-line mk2-reveal" style={revealStyle(2)}>
          The price on the card is the price on the receipt.
        </p>

        <div className="mk2-price-wrap mk2-reveal" style={revealStyle(3)}>
          <div className="mk2-price-glow" aria-hidden="true" />
          <div className="mk2-receipt" aria-label="Example session receipt">
            <div className="mk2-receipt-head">
              <span className="mk2-receipt-title">Consultation</span>
              <span className="mk2-receipt-tag">#BAL-20418</span>
            </div>
            <div className="mk2-receipt-row">
              <span>Flow debugging</span>
              <span className="mk2-mono">23 min</span>
            </div>
            <div className="mk2-receipt-row">
              <span>Rate</span>
              <span className="mk2-mono">A$2.40/min</span>
            </div>
            <div className="mk2-receipt-total">
              <span>Total</span>
              <span className="mk2-mono">A$55.20</span>
            </div>
            <div className="mk2-receipt-foot">
              <I.check size={12} />
              Service fee included
            </div>
          </div>
        </div>

        <p className="mk2-nos mk2-reveal" style={revealStyle(4)}>
          No retainers · No day rates · No minimums · No contracts
        </p>
      </div>
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────
// QUOTE — one voice, centred (placeholder until MJ sources real ones)
// ─────────────────────────────────────────────────────────────────
export function Quote(): React.JSX.Element {
  return (
    <Group className="mk2-sec-tight mk2-center mk2-tint-grad">
      <div className="mk2-wrap mk2-quote">
        <blockquote className="mk2-reveal">{QUOTE.text}</blockquote>
        <div className="mk2-quote-who mk2-reveal" style={revealStyle(1)}>
          <span className="mk2-quote-av" style={{ background: avatarGradient(QUOTE.name) }}>
            {initials(QUOTE.name)}
          </span>
          <div>
            <div className="mk2-quote-name">{QUOTE.name}</div>
            <div className="mk2-quote-role">{QUOTE.role}</div>
          </div>
        </div>
      </div>
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────
// EXPERT BAND — two lines, dark. No fee/margin language (invariant).
// Rows 8-9 of the wiring table: both CTAs route to `/expert/apply` — the only
// expert-facing surface that explains the model (Q1, approved: disclosed as a
// shared destination in the PR since no payouts explainer page exists).
// ─────────────────────────────────────────────────────────────────
export function Band(): React.JSX.Element {
  return (
    <div className="mk2-band" id="for-experts">
      <div className="mk2-band-glow mk2-band-glow-a" aria-hidden="true" />
      <div className="mk2-band-glow mk2-band-glow-b" aria-hidden="true" />
      <Group className="mk2-sec mk2-center">
        <div className="mk2-wrap">
          <span className="mk2-kicker mk2-reveal">For experts</span>
          <h2 className="mk2-h2 mk2-reveal" style={revealStyle(1)}>
            Keep the craft.
            <br />
            Skip the chase.
          </h2>
          <p className="mk2-line mk2-reveal" style={revealStyle(2)}>
            Set your rate, share your hours, get paid for every minute.
          </p>
          <div className="mk2-band-ctas mk2-reveal" style={revealStyle(3)}>
            <Link
              className="mk2-btn mk2-btn-lg mk2-btn-white"
              href="/expert/apply"
              prefetch={false}
            >
              Apply to join
              <I.arrow size={16} />
            </Link>
            <Link
              className="mk2-btn mk2-btn-lg mk2-btn-outline-light"
              href="/expert/apply"
              prefetch={false}
            >
              How experts get paid
            </Link>
          </div>
        </div>
      </Group>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// FINAL — closing fragment pair. Row 10: "Find an expert" stays the in-page
// anchor `#experts` (Q2, approved — not in the ticket's override list and it is
// a genuine in-page anchor). Row 11: "Apply as an expert" → `/expert/apply`
// (the ticket names this CTA explicitly, so the override applies even though
// the ref has it as an anchor).
// ─────────────────────────────────────────────────────────────────
export function Final(): React.JSX.Element {
  return (
    <Group className="mk2-sec mk2-center">
      <div className="mk2-wrap">
        <div className="mk2-final-card mk2-reveal">
          <h2 className="mk2-h2">
            Small questions welcome.
            <br />
            <em>Big problems too.</em>
          </h2>
          <div className="mk2-final-ctas">
            <a className="mk2-btn mk2-btn-lg mk2-btn-white" href="#experts">
              Find an expert
              <I.arrow size={16} />
            </a>
            <Link
              className="mk2-btn mk2-btn-lg mk2-btn-outline-light"
              href="/expert/apply"
              prefetch={false}
            >
              Apply as an expert
            </Link>
          </div>
        </div>
      </div>
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────
// FOOTER (compact, one row). Rows 12-14: logo mark and "Find experts / How it
// works / Pricing / For experts" stay unchanged in-page anchors; "Privacy" /
// "Terms" stay `href="#"` (Q3 — no `/privacy` or `/terms` route exists in this
// app; the ref itself lists footer links under PLACEHOLDERS). `FOOTER_LINKS`
// (`_lib/content.ts`) already encodes exactly these hrefs — nothing to special-
// case here.
// ─────────────────────────────────────────────────────────────────
export function Footer(): React.JSX.Element {
  return (
    <footer className="mk2-footer">
      <div className="mk2-wrap mk2-footer-inner">
        <a className="mk2-logo" href="#top" aria-label="Balo home">
          <span className="mk2-logo-mark" />
          Balo
        </a>
        <nav className="mk2-footer-links" aria-label="Footer">
          {FOOTER_LINKS.map(([l, h]) => (
            <a key={l} href={h}>
              {l}
            </a>
          ))}
        </nav>
        <span className="mk2-footer-legal">© 2026 Balo Technologies</span>
      </div>
    </footer>
  );
}
