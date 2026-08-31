import { ArrowRight } from 'lucide-react';
import { RevealGroup } from '@/components/marketing/motion/reveal-group';
import { CtaLink } from './cta-link';
import { VERTICAL } from './copy';

/**
 * BAL-493 §3 — the closing conversion band. Server component; both CTAs are `<CtaLink>`
 * islands (placement `'final'`).
 *
 * The band's OWN card background is the gradient (`.mk-final-card { background: var(--grad) }`
 * in `marketing-home.css`) — this is the "final CTA band" the gradient budget is reserved for,
 * alongside the hero search submit and the spotlight card's "Book a call" (`button.tsx`'s
 * gradient-variant docblock). The two buttons ON TOP of that gradient card are `mk-btn-white` /
 * `mk-btn-outline-light`, not `mk-btn-grad` — a gradient button on a gradient background would
 * be invisible, and `.mk-final-card`'s own `color: var(--primary-foreground)` already renders
 * the whole card's text white.
 *
 * ⚠ THE SECONDARY CTA IS THE PAGE'S CLIENT SIGNUP PATH (plan §19 deviation #12). D3 removed
 * "Get started" from the signed-out header on the explicit condition that the page still
 * offers one prominently, and the expert funnel is already carried twice above this band
 * ("Apply to join" and "How vetting works" in `expert-band-section.tsx`). A third expert CTA
 * here would leave the footer's "Create an account" as the only client-signup link on the
 * whole front door. Do not swap this back to "Become an expert".
 */
export function FinalCtaSection(): React.JSX.Element {
  return (
    <section className="mk-final" id="final">
      <RevealGroup className="mk-wrap">
        <div className="mk-final-card mk-reveal">
          <div className="mk-final-grid" aria-hidden="true" />
          <h2>Your next {VERTICAL.name} fix is minutes away.</h2>
          <p>Search vetted experts, book the next open slot, and pay only for the time you use.</p>
          <div className="mk-final-ctas">
            <CtaLink
              placement="final"
              label="Find an expert"
              href="/experts"
              className="mk-btn mk-btn-lg mk-btn-white"
            >
              Find an expert
              <ArrowRight size={16} aria-hidden="true" />
            </CtaLink>
            <CtaLink
              placement="final"
              label="Create a free account"
              href="/signup"
              className="mk-btn mk-btn-lg mk-btn-outline-light"
            >
              Create a free account
            </CtaLink>
          </div>
        </div>
      </RevealGroup>
    </section>
  );
}
