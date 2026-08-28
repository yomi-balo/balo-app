import { useState, useEffect, useRef, useMemo, createContext, useContext } from 'react';

// ─────────────────────────────────────────────────────────────────
// BALO MARKETING HOME — V1.1 (Balo 2.0)
// Design reference — no ticket yet (author under Platform project)
// ─────────────────────────────────────────────────────────────────
//
// WHAT THIS IS
// The logged-out home page for balo.expert on the new stack. One
// page, one job: get a client to search for (and book) a vetted
// expert. Secondary job: route experts to "Apply to join".
//
// REFERENCES
// • firmable.ai/au — section rhythm (hero → proof → capabilities →
//   audience → CTA), portrait warmth, one CTA repeated per section.
// • Airbnb — search-first hero, generous whitespace, cards with the
//   price on them, no decoration that isn't content.
//
// TYPE SYSTEM (repo font is Geist — authoritative)
// • Geist Sans 750 / -0.035em tracking for display; 400–600 for body.
// • Geist Mono for anything MEASURED: minutes, rates, counts, step
//   numbers, receipt lines. The mono/sans split is the type signature —
//   it says "metered and precise" without a single word of copy.
//
// PALETTE (tokens below) — Balo blue #2563EB → violet #7C3AED is the
// only saturated colour on the page. It appears as: the hero wash,
// primary CTAs, the H1 underline, the final band. Everything else is
// ink/greys so the gradient stays a signature, not a theme.
//
// SIGNATURE ELEMENT
// The hero search is the SearchComposer bar (FTS + Product facet): it
// types real Salesforce problems as its placeholder ("Our lead
// assignment Flow fails on update…"), and the words "on demand" get a
// gradient underline that DRAWS in — availability lighting up.
// Underneath, two rows of Salesforce PRODUCT tiles (mark, name,
// expert count) slide in opposite directions on scroll — the coverage
// "bench": whatever corner of Salesforce you're stuck in, it's here.
// That trio (problem → coverage → search) is the pitch in one viewport.
//
// MOTION PLAN (orchestrated, not scattered)
// 1. Load: hero children stagger up 60–100ms apart; underline draws
//    at ~0.9s; bench rises last.
// 2. Ambient: three gradient blobs drift on 22–30s loops (hero only).
// 3. Scroll parallax (rAF, direct DOM writes, no re-renders):
//    – bench row A ← left / row B → right, capped at 900px of scroll
//    – pricing receipt floats against scroll (factor 0.08)
//    – expert-band glows drift (0.12 / -0.08)
// 4. Scroll reveals: IntersectionObserver, once, per-group; children
//    stagger via --i (90ms). "How it works" progress bar draws across
//    and step dots light up in sequence.
// 5. Hover: gradient CTAs crossfade to the deeper gradient via a
//    ::before layer (gradients can't transition), cards lift 3–4px,
//    nav links get a gradient underline, chips lift 1px.
// 6. Nav: transparent over the hero → frosted glass after 24px.
// Reduced motion: honoured via OS preference AND the control strip.
// Parallax off, blobs static, typewriter shows the first phrase,
// reveals instant, underline pre-drawn, counters jump to value.
//
// CONTROL STRIP (dark bar at top, prototype only)
// • Hero: light (default — Airbnb-clean, welcoming) / deep (night
//   background with brighter glows, for comparison).
// • Motion: full / reduced.
//
// REUSE (reuse-first)
// • Spotlight cards are a visual stand-in for <ExpertCard> (BAL-214,
//   expert-profile-card-v2.jsx). Production must render the real
//   component — the stand-in omits skill-type icons in pills.
// • Hero search MIRRORS the SearchComposer unified bar (BAL-249,
//   search-composer.jsx): FTS field + Product facet popover + submit.
//   Production must mount the real component (it also carries the
//   Support/When segments and the mobile one-trigger sheet); the
//   popover here is a visual stand-in for its ProductSelector, wired
//   to the same { q, products[] } contract. The "Popular" chips toggle
//   the SAME products[] state — chip ↔ facet token ↔ badge stay in sync.
// • Avatar gradients use the same 6-gradient hash as ExpertCard so
//   faces match across marketing → search → profile.
//
// INVARIANTS RESPECTED
// • Fee concealment: every rate on this page is the client all-in
//   per-minute rate. "Service fee included" is the only fee language.
//   No margin, no percentage, nothing on the expert band about cut.
// • Gradient CTA rule: this is a marketing/conversion surface, so
//   primary CTAs use the blue→violet gradient. The booking-fragment
//   time picker uses solid --primary (reusable picker, context-neutral).
// • Copy is gender-neutral throughout.
// • Vertical seam: Salesforce is a value in VERTICAL below, not welded
//   into markup — headline, phrases, chips and product names all read
//   from it, so a second vertical is a config change.
//
// PLACEHOLDERS — all sample, none are claims
// • Live count (38), proof metrics (1% / 4.9 / <2 hrs / 40+),
//   per-product expert counts on the bench tiles, spotlight experts,
//   receipt, testimonials, footer links. MJ holds copy checkpoints on
//   all money strings, counts and quotes.
// • Logo mark is a stand-in — swap for the real asset.
//
// SUGGESTED ANALYTICS (for the ticket)
// hero_search_submitted {query_len, product_count}, hero_facet_opened,
// hero_product_toggled {product, source: facet|chip},
// product_tile_clicked {product, row}, cta_clicked
// {placement: nav|hero|ways|experts|pricing|band|final, label},
// spotlight_book_clicked {expert_id}, section_viewed {id}.
//
// OPEN QUESTIONS
// 1. Product marks: bench tiles ship NEUTRAL glyph chips. Using real
//    Salesforce product logos needs a partner-branding / trademark
//    check first (product NAMES as nominative use are fine). Decide
//    before build; the mark is one <span> either way.
// 2. Marketing hero mounts a TRIMMED composer (FTS + Product) — confirm
//    with MJ whether Support/When segments belong on marketing too.
// 3. Packages framing ("set price, no scoping call") — confirm with MJ.
// 4. Where marketing lives: apps/web (marketing) route group vs a
//    separate app. Parallax + IO hooks are client components either way.
//
// REVISIONS (V1 → V1.1, per Yomi 2026-08-28)
// • Nav CTA "Find an expert": gradient → solid --primary, white text.
// • H1: "Salesforce experts, by the minute." → "Top Salesforce
//   experts, on demand." (underline now on "on demand"; per-minute
//   message moved into the lede).
// • Hero bench: expert tiles → Salesforce product-coverage tiles.
// • Hero search: bare input → SearchComposer-style bar with a working
//   Product facet popover (taxonomy mirrored from BAL-249).
// ─────────────────────────────────────────────────────────────────

// ── Vertical config (the seam) ─────────────────────────────────────
const VERTICAL = {
  name: 'Salesforce',
  phrases: [
    'Our lead assignment Flow fails on every update…',
    'Need CPQ quote templates fixed before Friday…',
    'Planning our first Data Cloud rollout…',
    'Set up an Agentforce pilot for the support team…',
    'Marketing Cloud journeys stopped sending…',
    'Migrating from Classic to Lightning…',
  ],
  // Chips toggle the products[] facet — every value must be an exact
  // TAXONOMY item so chip / token / badge stay one state.
  chips: ['Agentforce', 'Data Cloud', 'CPQ', 'Sales Cloud', 'Service Cloud', 'MuleSoft', 'Tableau'],
};

// Mirrors the BAL-249 SearchComposer taxonomy (that file is the source
// of truth) — used by the Product facet popover.
const TAXONOMY = [
  { group: 'AI', items: ['Agentforce'] },
  { group: 'Data Cloud', items: ['Data Cloud'] },
  { group: 'Sales Cloud', items: ['CPQ', 'Sales Cloud'] },
  {
    group: 'Service Cloud',
    items: ['Digital Engagement', 'Field Service', 'Service Cloud', 'Voice'],
  },
  {
    group: 'Marketing Cloud',
    items: [
      'Account Engagement',
      'Engagement',
      'Intelligence',
      'Loyalty Management',
      'Personalisation',
    ],
  },
  { group: 'Slack', items: ['Slack'] },
  { group: 'Experience Cloud', items: ['Experience Cloud'] },
  { group: 'Commerce Cloud', items: ['B2B Commerce', 'B2C Commerce', 'Order Management'] },
  {
    group: 'Platform',
    items: ['AppExchange', 'Heroku', 'Hyperforce', 'Salesforce Platform', 'Security', 'Shield'],
  },
  { group: 'Tableau', items: ['CRM Analytics', 'Tableau'] },
  { group: 'MuleSoft', items: ['MuleSoft'] },
  {
    group: 'Industries',
    items: [
      'Communications Cloud',
      'Consumer Goods Cloud',
      'Education Cloud',
      'Energy & Utilities Cloud',
      'Financial Services Cloud',
      'Government Cloud',
      'Health Cloud',
      'Manufacturing Cloud',
      'Media Cloud',
      'Nonprofit Cloud',
      'OmniStudio',
    ],
  },
  { group: 'Net Zero Cloud', items: ['Net Zero Cloud'] },
];
const DENSE_CAP = 4; // per-group chip cap before "+n more" (matches BAL-249)

// ── Design tokens ─────────────────────────────────────────────────
const c = {
  ink: '#111827',
  night: '#0B1220',
  text2: '#4B5563',
  text3: '#9CA3AF',
  line: '#E5E9F0',
  lineSoft: '#EEF1F6',
  mist: '#F5F7FB',
  primary: '#2563EB',
  primaryDeep: '#1D4ED8',
  violet: '#7C3AED',
  violetDeep: '#6D28D9',
  success: '#059669',
  successBright: '#34D399',
  amber: '#F59E0B',
  gradient: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
  gradientHover: 'linear-gradient(135deg, #1D4ED8 0%, #6D28D9 100%)',
};

// ── Global styles ──────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400..800&family=Geist+Mono:wght@400..600&display=swap');

*, *::before, *::after { box-sizing: border-box; }
html { scroll-behavior: smooth; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
html, body { margin: 0; }
body { background: ${c.night}; }

/* ── Page root + tokens ── */
.mk-page {
  --ink: ${c.ink}; --night: ${c.night}; --text2: ${c.text2}; --text3: ${c.text3};
  --line: ${c.line}; --line-soft: ${c.lineSoft}; --mist: ${c.mist};
  --primary: ${c.primary}; --primary-deep: ${c.primaryDeep};
  --violet: ${c.violet}; --violet-deep: ${c.violetDeep};
  --success: ${c.success}; --success-bright: ${c.successBright}; --amber: ${c.amber};
  --grad: ${c.gradient}; --grad-hover: ${c.gradientHover};
  --sans: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --mono: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --ease: cubic-bezier(.22, .61, .36, 1);
  --wrap: 1180px;
  font-family: var(--sans);
  color: var(--ink);
  background: #fff;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  overflow-x: clip;
}
.mk-wrap { max-width: var(--wrap); margin: 0 auto; padding: 0 24px; }
.mk-mono { font-family: var(--mono); font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.mk-page a { color: inherit; }
.mk-page button { font-family: inherit; }
.mk-page :focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.mk-search-field input:focus-visible { outline: none; } /* ring comes from .mk-search:focus-within */

/* ── Control strip (prototype only) ── */
.mk-ctl {
  background: ${c.night}; color: #fff;
  font-family: 'Geist Mono', ui-monospace, monospace; font-size: 11px;
  padding: 10px 20px; display: flex; align-items: center; gap: 22px; flex-wrap: wrap;
  border-bottom: 1px solid rgba(255,255,255,.08);
}
.mk-ctl-title { font-family: 'Geist', sans-serif; font-weight: 600; font-size: 12px; letter-spacing: .01em; margin-right: auto; }
.mk-ctl-title span { color: rgba(255,255,255,.4); font-weight: 500; }
.mk-ctl-group { display: flex; align-items: center; gap: 8px; }
.mk-ctl-label { color: rgba(255,255,255,.45); text-transform: uppercase; letter-spacing: .08em; font-size: 10px; }
.mk-ctl-note { color: rgba(255,255,255,.45); font-size: 10px; }
.mk-seg { display: flex; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1); border-radius: 8px; padding: 2px; }
.mk-seg button { background: transparent; border: none; color: rgba(255,255,255,.55); font: inherit; padding: 4px 10px; border-radius: 6px; cursor: pointer; transition: all .15s; text-transform: capitalize; }
.mk-seg button.on { background: #fff; color: ${c.night}; font-weight: 600; }

/* ── Buttons ── */
.mk-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  height: 44px; padding: 0 20px; border-radius: 12px;
  font: 600 14px/1 var(--sans); cursor: pointer; text-decoration: none; white-space: nowrap;
  border: 1px solid transparent;
  transition: transform .2s var(--ease), box-shadow .2s var(--ease), background .2s, border-color .2s, color .2s;
}
.mk-btn:active { transform: translateY(0) scale(.98); }
.mk-btn-lg { height: 52px; padding: 0 26px; font-size: 15px; border-radius: 14px; }
.mk-btn-grad { position: relative; overflow: hidden; isolation: isolate; background: var(--grad); color: #fff; box-shadow: 0 2px 10px rgba(37,99,235,.28); }
.mk-btn-grad::before { content: ''; position: absolute; inset: 0; background: var(--grad-hover); opacity: 0; transition: opacity .25s; z-index: -1; }
.mk-btn-grad:hover { transform: translateY(-1px); box-shadow: 0 8px 22px rgba(37,99,235,.32); }
.mk-btn-grad:hover::before { opacity: 1; }
.mk-btn-solid { background: var(--primary); color: #fff; box-shadow: 0 2px 8px rgba(37,99,235,.25); }
.mk-btn-solid:hover { background: var(--primary-deep); transform: translateY(-1px); box-shadow: 0 6px 18px rgba(37,99,235,.3); }
.mk-btn-ghost { background: transparent; color: var(--ink); border-color: var(--line); }
.mk-btn-ghost:hover { background: var(--mist); border-color: #D5DAE3; }
.mk-btn-text { background: transparent; color: var(--text2); padding: 0 12px; }
.mk-btn-text:hover { color: var(--ink); background: var(--mist); }
.mk-btn-white { background: #fff; color: var(--ink); }
.mk-btn-white:hover { transform: translateY(-1px); box-shadow: 0 8px 22px rgba(0,0,0,.18); }
.mk-btn-outline-light { background: rgba(255,255,255,.06); color: #fff; border-color: rgba(255,255,255,.25); }
.mk-btn-outline-light:hover { background: rgba(255,255,255,.12); border-color: rgba(255,255,255,.4); }
.mk-btn svg { transition: transform .2s var(--ease); }
.mk-btn:hover svg.mk-arrow { transform: translateX(3px); }

/* ── Nav ── */
.mk-nav { position: sticky; top: 0; z-index: 40; border-bottom: 1px solid transparent; transition: background .3s, border-color .3s, box-shadow .3s; }
.mk-nav.is-scrolled { background: rgba(255,255,255,.84); -webkit-backdrop-filter: saturate(180%) blur(14px); backdrop-filter: saturate(180%) blur(14px); border-color: var(--line); }
.mk-nav-inner { height: 68px; display: flex; align-items: center; gap: 28px; }
.mk-logo { display: flex; align-items: center; gap: 9px; font-weight: 700; font-size: 19px; letter-spacing: -.02em; text-decoration: none; }
.mk-logo-mark { width: 28px; height: 28px; border-radius: 8px; background: var(--grad); position: relative; box-shadow: 0 2px 6px rgba(37,99,235,.3); }
.mk-logo-mark::after { content: ''; position: absolute; left: 8px; top: 8px; width: 12px; height: 12px; border-radius: 4px 4px 4px 1px; background: #fff; }
.mk-nav-links { display: flex; gap: 2px; margin-left: 6px; }
.mk-nav-link { position: relative; padding: 8px 12px; font-size: 14px; font-weight: 500; color: var(--text2); text-decoration: none; border-radius: 8px; transition: color .15s; }
.mk-nav-link::after { content: ''; position: absolute; left: 12px; right: 12px; bottom: 3px; height: 2px; background: var(--grad); border-radius: 2px; transform: scaleX(0); transform-origin: left; transition: transform .25s var(--ease); }
.mk-nav-link:hover { color: var(--ink); }
.mk-nav-link:hover::after { transform: scaleX(1); }
.mk-nav-right { margin-left: auto; display: flex; gap: 8px; align-items: center; }
.mk-burger { display: none; width: 44px; height: 44px; border-radius: 12px; border: 1px solid var(--line); background: #fff; color: var(--ink); align-items: center; justify-content: center; cursor: pointer; }
.mk-mnav { position: absolute; left: 0; right: 0; top: 100%; z-index: 39; background: rgba(255,255,255,.96); -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); border-bottom: 1px solid var(--line); padding: 12px 24px 20px; display: flex; flex-direction: column; gap: 4px; animation: mk-drop .25s var(--ease) both; }
.mk-mnav-link { padding: 12px 10px; font-size: 16px; font-weight: 500; text-decoration: none; border-radius: 10px; }
.mk-mnav-link:hover { background: var(--mist); }
@media (max-width: 860px) {
  .mk-nav-links, .mk-nav-login { display: none; }
  .mk-burger { display: flex; }
}
/* Nav over the deep hero — light text until it turns to glass */
.mk-page.deep .mk-nav:not(.is-scrolled) { color: #fff; }
.mk-page.deep .mk-nav:not(.is-scrolled) .mk-nav-link { color: rgba(255,255,255,.72); }
.mk-page.deep .mk-nav:not(.is-scrolled) .mk-nav-link:hover { color: #fff; }
.mk-page.deep .mk-nav:not(.is-scrolled) .mk-btn-text { color: rgba(255,255,255,.8); }
.mk-page.deep .mk-nav:not(.is-scrolled) .mk-btn-text:hover { color: #fff; background: rgba(255,255,255,.1); }
.mk-page.deep .mk-nav:not(.is-scrolled) .mk-burger { background: rgba(255,255,255,.08); border-color: rgba(255,255,255,.2); color: #fff; }

/* ── Hero ── */
.mk-hero { position: relative; overflow: hidden; padding: 60px 0 0; }
.mk-hero-bg { position: absolute; inset: 0; pointer-events: none; }
.mk-blob { position: absolute; border-radius: 50%; filter: blur(50px); will-change: transform; }
.mk-blob-a { width: 640px; height: 640px; left: -160px; top: -260px; background: radial-gradient(circle at 40% 40%, rgba(37,99,235,.30), rgba(37,99,235,0) 65%); animation: mk-drift-a 22s ease-in-out infinite alternate; }
.mk-blob-b { width: 720px; height: 720px; right: -220px; top: -220px; background: radial-gradient(circle at 60% 40%, rgba(124,58,237,.26), rgba(124,58,237,0) 65%); animation: mk-drift-b 26s ease-in-out infinite alternate; }
.mk-blob-c { width: 520px; height: 520px; left: 36%; top: 260px; background: radial-gradient(circle, rgba(37,99,235,.12), transparent 65%); animation: mk-drift-c 30s ease-in-out infinite alternate; }
.mk-grid { position: absolute; inset: 0; opacity: .16; background-image: radial-gradient(rgba(17,24,39,.4) .8px, transparent .9px); background-size: 26px 26px; -webkit-mask-image: radial-gradient(ellipse 70% 60% at 50% 28%, #000 30%, transparent 75%); mask-image: radial-gradient(ellipse 70% 60% at 50% 28%, #000 30%, transparent 75%); }
.mk-hero-fade { position: absolute; left: 0; right: 0; bottom: 0; height: 200px; background: linear-gradient(to bottom, rgba(255,255,255,0), #fff); }

.mk-hero-inner { position: relative; text-align: center; max-width: 860px; margin: 0 auto; padding: 0 24px; }
.mk-hero-inner > * { animation: mk-up .75s var(--ease) both; }
.mk-hero-inner > :nth-child(1) { animation-delay: .05s; }
.mk-hero-inner > :nth-child(2) { animation-delay: .14s; }
.mk-hero-inner > :nth-child(3) { animation-delay: .24s; }
.mk-hero-inner > :nth-child(4) { animation-delay: .34s; }
.mk-hero-inner > :nth-child(5) { animation-delay: .44s; }

.mk-live { display: inline-flex; align-items: center; gap: 8px; padding: 6px 13px 6px 9px; border-radius: 999px; background: #fff; border: 1px solid var(--line); box-shadow: 0 1px 2px rgba(0,0,0,.04); font-size: 13px; font-weight: 500; color: var(--text2); }
.mk-live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success-bright); animation: mk-ping 2s infinite; }
.mk-live-n { color: var(--ink); font-weight: 600; }

.mk-h1 { font-size: clamp(34px, 7vw, 68px); line-height: 1.02; letter-spacing: -.035em; font-weight: 750; margin: 24px 0 20px; }
.mk-h1-em { position: relative; white-space: nowrap; }
.mk-underline { position: absolute; left: -1%; bottom: -.06em; width: 102%; height: .2em; overflow: visible; }
.mk-underline path { animation: mk-draw 1.1s var(--ease) .9s forwards; }
.mk-lede { font-size: clamp(16px, 1.6vw, 19px); color: var(--text2); max-width: 600px; margin: 0 auto 30px; line-height: 1.55; }

.mk-search { position: relative; display: flex; align-items: center; gap: 8px; max-width: 760px; margin: 0 auto; padding: 6px 6px 6px 18px; background: #fff; border: 1px solid var(--line); border-radius: 18px; box-shadow: 0 10px 40px rgba(17,24,39,.08), 0 1px 2px rgba(17,24,39,.05); transition: box-shadow .25s var(--ease), border-color .25s; text-align: left; }
.mk-search:focus-within { border-color: rgba(37,99,235,.5); box-shadow: 0 12px 44px rgba(37,99,235,.14), 0 0 0 4px rgba(37,99,235,.10); }
.mk-search-icon { color: var(--text3); display: flex; flex-shrink: 0; }
.mk-search-field { position: relative; flex: 1; min-width: 0; height: 44px; }
.mk-search-field input { width: 100%; height: 100%; border: none; outline: none; background: transparent; font: 500 16px var(--sans); color: var(--ink); padding: 0; }
.mk-search-ghost { position: absolute; left: 0; top: 0; height: 100%; display: flex; align-items: center; font-size: 16px; color: var(--text3); pointer-events: none; white-space: nowrap; overflow: hidden; max-width: 100%; }
.mk-caret { display: inline-block; width: 2px; height: 18px; background: var(--primary); margin-left: 2px; animation: mk-blink 1s steps(2) infinite; }
.mk-sdiv { width: 1px; align-self: stretch; margin: 8px 0; background: var(--line-soft); flex-shrink: 0; }

/* Product facet (mirrors the BAL-249 unified-bar segment) */
.mk-facet { display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 12px; border: none; background: transparent; border-radius: 10px; cursor: pointer; color: var(--text2); transition: background .15s; flex-shrink: 0; }
.mk-facet:hover, .mk-facet.is-open { background: var(--mist); }
.mk-facet-txt { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.15; }
.mk-facet-lab { font-family: var(--mono); font-size: 9.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--text3); }
.mk-facet-val { font-size: 13px; font-weight: 500; color: var(--text3); max-width: 110px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mk-facet-val.has { color: var(--ink); font-weight: 600; }
.mk-facet-badge { min-width: 17px; height: 17px; padding: 0 4px; border-radius: 9px; background: var(--primary); color: #fff; font-size: 10.5px; font-weight: 600; display: flex; align-items: center; justify-content: center; }
.mk-facet svg { transition: transform .2s var(--ease); }
.mk-facet svg.mk-rot { transform: rotate(180deg); }

.mk-facet-pop { position: absolute; top: calc(100% + 10px); right: 0; width: min(460px, calc(100vw - 48px)); background: #fff; border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 24px 60px -12px rgba(17,24,39,.25); padding: 14px; z-index: 30; text-align: left; animation: mk-drop .2s var(--ease) both; }
.mk-pop-search { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 12px; border: 1px solid var(--line); border-radius: 10px; color: var(--text3); }
.mk-pop-search input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; font: 500 13.5px var(--sans); color: var(--ink); }
.mk-pop-search input:focus-visible { outline: none; }
.mk-pop-x { display: flex; background: none; border: none; cursor: pointer; color: var(--text3); padding: 2px; }
.mk-pop-sel { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; font-size: 11px; color: var(--text2); }
.mk-pop-sel button { background: none; border: none; cursor: pointer; font: 500 12px var(--sans); color: var(--text2); text-decoration: underline; }
.mk-pop-scroll { max-height: 280px; overflow-y: auto; margin-top: 12px; padding-right: 4px; }
.mk-pop-group { margin-bottom: 14px; }
.mk-pop-glab { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em; color: var(--text2); margin-bottom: 8px; }
.mk-pop-glab em { font-style: normal; color: var(--text3); margin-left: 6px; }
.mk-pop-chips { display: flex; flex-wrap: wrap; gap: 7px; }
.mk-pchip { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; border-radius: 9px; font: 500 12.5px var(--sans); color: var(--ink); background: #fff; border: 1px solid var(--line); cursor: pointer; transition: all .15s var(--ease); }
.mk-pchip:hover { border-color: rgba(37,99,235,.45); background: var(--mist); }
.mk-pchip.on { color: var(--primary); background: #EFF6FF; border-color: #BFDBFE; font-weight: 600; }
.mk-pchip-more { border-style: dashed; color: var(--text2); }
.mk-pop-none { font-size: 13px; color: var(--text3); text-align: center; padding: 18px 0; margin: 0; }
@media (max-width: 640px) {
  .mk-search { flex-wrap: wrap; padding: 10px; border-radius: 16px; gap: 8px; }
  .mk-search-icon { display: none; }
  .mk-search-field { flex-basis: 100%; padding: 0 8px; }
  .mk-sdiv { display: none; }
  .mk-facet { flex: 1; justify-content: center; border: 1px solid var(--line); border-radius: 12px; }
  .mk-search .mk-btn { flex: 1; }
  .mk-facet-pop { left: 0; right: 0; width: auto; }
}

.mk-chips { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 8px; margin: 18px auto 0; max-width: 720px; }
.mk-chips-label { font-size: 12.5px; color: var(--text3); margin-right: 2px; }
.mk-chip { font-size: 13px; font-weight: 500; color: var(--text2); background: rgba(255,255,255,.72); border: 1px solid var(--line); border-radius: 999px; padding: 7px 13px; cursor: pointer; transition: all .18s var(--ease); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); }
.mk-chip:hover { color: var(--primary); border-color: rgba(37,99,235,.4); background: #fff; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(37,99,235,.10); }
.mk-chip.on { color: var(--primary); border-color: rgba(37,99,235,.5); background: #EFF6FF; font-weight: 600; }

/* ── Bench (parallax expert tiles) ── */
.mk-bench { position: relative; margin-top: 60px; padding: 6px 0 44px; overflow: hidden; animation: mk-up .9s var(--ease) .55s both; -webkit-mask-image: linear-gradient(to right, transparent, #000 12%, #000 88%, transparent); mask-image: linear-gradient(to right, transparent, #000 12%, #000 88%, transparent); }
.mk-bench-row { display: flex; gap: 14px; width: max-content; margin-left: -40px; padding: 4px 0; will-change: transform; }
.mk-bench-row-b { margin-top: 14px; margin-left: -240px; }
.mk-tile { color: var(--ink); display: flex; align-items: center; gap: 12px; padding: 10px 14px 10px 10px; background: rgba(255,255,255,.92); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 1px 2px rgba(17,24,39,.04), 0 8px 24px -12px rgba(17,24,39,.14); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); cursor: pointer; transition: transform .25s var(--ease), box-shadow .25s var(--ease), border-color .2s; }
.mk-tile:hover { transform: translateY(-3px); box-shadow: 0 14px 30px -12px rgba(37,99,235,.28); border-color: rgba(37,99,235,.35); }
.mk-avatar { position: relative; width: 42px; height: 42px; border-radius: 12px; display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; font-size: 14px; letter-spacing: -.02em; flex-shrink: 0; }
.mk-mark { width: 40px; height: 40px; border-radius: 12px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.mk-tile-name { font-size: 14px; font-weight: 600; line-height: 1.2; white-space: nowrap; }
.mk-tile-count { font-family: var(--mono); font-size: 11px; color: var(--text3); margin-top: 3px; white-space: nowrap; }

/* Deep hero variant */
.mk-page.deep .mk-hero { background: var(--night); color: #fff; }
.mk-page.deep .mk-blob-a { background: radial-gradient(circle at 40% 40%, rgba(37,99,235,.55), rgba(37,99,235,0) 65%); }
.mk-page.deep .mk-blob-b { background: radial-gradient(circle at 60% 40%, rgba(124,58,237,.5), rgba(124,58,237,0) 65%); }
.mk-page.deep .mk-blob-c { background: radial-gradient(circle, rgba(37,99,235,.22), transparent 65%); }
.mk-page.deep .mk-grid { background-image: radial-gradient(rgba(255,255,255,.55) .8px, transparent .9px); opacity: .12; }
.mk-page.deep .mk-hero-fade { display: none; }
.mk-page.deep .mk-live { background: rgba(255,255,255,.08); border-color: rgba(255,255,255,.15); color: rgba(255,255,255,.75); }
.mk-page.deep .mk-live-n { color: #fff; }
.mk-page.deep .mk-lede { color: rgba(255,255,255,.7); }
.mk-page.deep .mk-chips-label { color: rgba(255,255,255,.45); }
.mk-page.deep .mk-chip { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.15); color: rgba(255,255,255,.78); }
.mk-page.deep .mk-chip:hover { background: rgba(255,255,255,.12); color: #fff; border-color: rgba(255,255,255,.35); box-shadow: none; }
.mk-page.deep .mk-chip.on { background: rgba(37,99,235,.3); border-color: rgba(96,165,250,.6); color: #DBEAFE; }
.mk-page.deep .mk-tile { background: rgba(255,255,255,.96); }
.mk-page.deep .mk-proof { background: var(--night); color: #fff; border-color: rgba(255,255,255,.08); }
.mk-page.deep .mk-proof-item { border-color: rgba(255,255,255,.08); }
.mk-page.deep .mk-proof-lab { color: rgba(255,255,255,.6); }

/* ── Proof band ── */
.mk-proof { border-top: 1px solid var(--line-soft); border-bottom: 1px solid var(--line-soft); background: #fff; }
.mk-proof-inner { display: grid; grid-template-columns: repeat(4, 1fr); }
.mk-proof-item { padding: 26px 20px; text-align: center; border-left: 1px solid var(--line-soft); }
.mk-proof-item:first-child { border-left: none; }
.mk-proof-val { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 30px; font-weight: 600; letter-spacing: -.03em; line-height: 1; }
.mk-proof-lab { font-size: 13px; color: var(--text2); margin-top: 8px; }
@media (max-width: 720px) {
  .mk-proof-inner { grid-template-columns: 1fr 1fr; }
  .mk-proof-item { padding: 20px 12px; }
  .mk-proof-item:nth-child(3) { border-left: none; }
  .mk-proof-item:nth-child(n+3) { border-top: 1px solid var(--line-soft); }
}

/* ── Sections ── */
.mk-section { padding: 100px 0; }
.mk-mist { background: var(--mist); }
.mk-eyebrow { display: inline-flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 12px; font-weight: 500; letter-spacing: .06em; text-transform: uppercase; color: var(--primary); }
.mk-eyebrow::before { content: ''; width: 18px; height: 2px; background: var(--grad); border-radius: 2px; }
.mk-h2 { font-size: clamp(30px, 3.6vw, 44px); line-height: 1.08; letter-spacing: -.03em; font-weight: 700; margin: 14px 0 14px; text-wrap: balance; }
.mk-sub { font-size: 17px; color: var(--text2); max-width: 560px; line-height: 1.55; margin: 0; }
.mk-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 32px; margin-bottom: 48px; }
.mk-head-link { font-weight: 600; color: var(--primary); text-decoration: none; display: inline-flex; gap: 6px; align-items: center; white-space: nowrap; padding-bottom: 6px; }
.mk-head-link svg { transition: transform .2s var(--ease); }
.mk-head-link:hover svg { transform: translateX(3px); }
@media (max-width: 720px) {
  .mk-section { padding: 64px 0; }
  .mk-head { flex-direction: column; align-items: flex-start; gap: 16px; margin-bottom: 36px; }
}

/* ── Scroll reveals ── */
.mk-reveal { opacity: 0; transform: translateY(18px); transition: opacity .75s var(--ease), transform .75s var(--ease); transition-delay: calc(var(--i, 0) * 90ms); }
.mk-reveal-group.is-in .mk-reveal { opacity: 1; transform: none; }
/* Hover-transform cards sit INSIDE a .mk-reveal wrapper so the reveal's
   transition-delay never leaks into hover/un-hover. */
.mk-reveal > .mk-way, .mk-reveal > .mk-xc, .mk-reveal > .mk-quote, .mk-reveal > .mk-perk { height: 100%; }

/* ── Ways to work ── */
.mk-ways { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
.mk-way { position: relative; background: #fff; border: 1px solid var(--line); border-radius: 22px; padding: 28px; overflow: hidden; transition: transform .3s var(--ease), box-shadow .3s var(--ease), border-color .2s; }
.mk-way::before { content: ''; position: absolute; right: -70px; top: -70px; width: 220px; height: 220px; background: radial-gradient(circle, rgba(124,58,237,.13), transparent 65%); opacity: 0; transition: opacity .35s; }
.mk-way:hover { transform: translateY(-4px); box-shadow: 0 24px 48px -24px rgba(17,24,39,.22); border-color: #D8DEE8; }
.mk-way:hover::before { opacity: 1; }
.mk-way-icon { width: 46px; height: 46px; border-radius: 13px; display: flex; align-items: center; justify-content: center; background: var(--mist); color: var(--primary); border: 1px solid var(--line-soft); transition: all .3s var(--ease); position: relative; }
.mk-way:hover .mk-way-icon { background: var(--grad); color: #fff; border-color: transparent; box-shadow: 0 6px 16px rgba(37,99,235,.3); }
.mk-way-kicker { font-family: var(--mono); font-size: 11.5px; color: var(--text3); text-transform: uppercase; letter-spacing: .06em; margin-top: 22px; }
.mk-way h3 { font-size: 22px; letter-spacing: -.02em; margin: 6px 0 10px; font-weight: 700; }
.mk-way p { color: var(--text2); font-size: 15px; line-height: 1.55; margin: 0; }
.mk-way-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 24px; padding-top: 18px; border-top: 1px solid var(--line-soft); }
.mk-way-tag { font-family: var(--mono); font-size: 12.5px; font-weight: 600; color: var(--ink); }
.mk-way-link { font-size: 14px; font-weight: 600; color: var(--primary); display: inline-flex; gap: 5px; align-items: center; text-decoration: none; }
.mk-way-link svg { transition: transform .2s var(--ease); }
.mk-way:hover .mk-way-link svg { transform: translateX(3px); }
@media (max-width: 900px) { .mk-ways { grid-template-columns: 1fr; } }

/* ── How it works ── */
.mk-steps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 22px; position: relative; }
.mk-steps-track { position: absolute; left: 0; right: 0; top: 5px; height: 2px; background: var(--line); }
.mk-steps-progress { position: absolute; left: 0; top: 5px; height: 2px; width: 100%; background: var(--grad); transform-origin: left; transform: scaleX(0); transition: transform 1.6s var(--ease) .25s; }
.mk-reveal-group.is-in .mk-steps-progress { transform: scaleX(1); }
.mk-step { position: relative; padding-top: 26px; }
.mk-step-dot { position: absolute; top: 0; left: 0; width: 12px; height: 12px; border-radius: 50%; background: #fff; border: 2px solid var(--line); transition: all .4s var(--ease); transition-delay: calc(var(--i, 0) * 260ms); }
.mk-reveal-group.is-in .mk-step-dot { background: var(--grad); border-color: transparent; box-shadow: 0 0 0 4px rgba(37,99,235,.12); }
.mk-step-num { font-family: var(--mono); font-size: 12px; font-weight: 600; color: var(--primary); letter-spacing: .06em; }
.mk-step h3 { font-size: 18px; font-weight: 700; letter-spacing: -.015em; margin: 8px 0 6px; }
.mk-step p { font-size: 14.5px; color: var(--text2); margin: 0; line-height: 1.55; }
.mk-frag { margin-top: 18px; background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 12px; box-shadow: 0 1px 2px rgba(17,24,39,.04); min-height: 112px; font-size: 12.5px; display: flex; flex-direction: column; gap: 8px; transition: transform .25s var(--ease), box-shadow .25s var(--ease); }
.mk-step:hover .mk-frag { transform: translateY(-2px); box-shadow: 0 12px 28px -14px rgba(17,24,39,.2); }
.mk-frag-search { display: flex; align-items: center; gap: 8px; color: var(--text2); }
.mk-frag-search > span { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mk-frag-tag { align-self: flex-start; font-family: var(--mono); font-size: 10.5px; color: var(--primary); background: rgba(37,99,235,.08); border-radius: 6px; padding: 3px 7px; }
.mk-frag-row { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 9px; border: 1px solid transparent; }
.mk-frag-row.on { background: rgba(37,99,235,.06); border-color: rgba(37,99,235,.18); }
.mk-frag-av { width: 22px; height: 22px; border-radius: 7px; color: #fff; font-size: 9px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.mk-frag-name { font-weight: 600; font-size: 12px; line-height: 1.2; }
.mk-frag-meta { color: var(--text3); font-size: 10.5px; font-family: var(--mono); }
.mk-frag-check { margin-left: auto; color: var(--success); display: flex; }
.mk-frag-day { font-size: 10.5px; color: var(--text3); font-family: var(--mono); text-transform: uppercase; letter-spacing: .06em; }
.mk-frag-slots { display: flex; gap: 6px; flex-wrap: wrap; }
.mk-frag-slots span { font-family: var(--mono); font-size: 11px; padding: 5px 8px; border-radius: 8px; border: 1px solid var(--line); color: var(--text2); }
.mk-frag-slots span.on { background: var(--primary); color: #fff; border-color: transparent; }
.mk-frag-line { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--line-soft); color: var(--text2); }
.mk-frag-line .mk-mono { color: var(--ink); font-weight: 500; }
.mk-frag-paid { align-self: flex-start; font-size: 11px; font-weight: 600; color: var(--success); background: rgba(5,150,105,.1); padding: 4px 8px; border-radius: 999px; }
@media (max-width: 900px) {
  .mk-steps { grid-template-columns: 1fr 1fr; }
  .mk-steps-track, .mk-steps-progress { display: none; }
  .mk-step { padding-top: 0; padding-left: 24px; }
  .mk-step-dot { top: 4px; }
}
@media (max-width: 560px) { .mk-steps { grid-template-columns: 1fr; } }

/* ── Vetting strip + spotlight cards ── */
.mk-vet { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 40px; }
.mk-vet-item { display: flex; gap: 10px; align-items: flex-start; padding: 14px 16px; background: #fff; border: 1px solid var(--line); border-radius: 14px; font-size: 13.5px; line-height: 1.4; }
.mk-vet-check { width: 20px; height: 20px; border-radius: 50%; background: rgba(5,150,105,.12); color: var(--success); display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px; }
.mk-vet-item strong { display: block; font-weight: 600; }
.mk-vet-item span { color: var(--text2); font-size: 12.5px; }
@media (max-width: 900px) { .mk-vet { grid-template-columns: 1fr 1fr; } }

.mk-experts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 22px; }
.mk-xc { background: #fff; border: 1px solid var(--line); border-radius: 20px; overflow: hidden; box-shadow: 0 4px 24px rgba(17,24,39,.06); display: flex; flex-direction: column; transition: transform .3s var(--ease), box-shadow .3s var(--ease); }
.mk-xc:hover { transform: translateY(-4px); box-shadow: 0 24px 48px -20px rgba(17,24,39,.25); }
.mk-xc-hero { position: relative; height: 156px; background: linear-gradient(160deg, #0F4C81 0%, #1e3a5f 45%, #0a1628 100%); }
.mk-xc-texture { position: absolute; inset: 0; opacity: .05; background-image: radial-gradient(circle, #fff 1px, transparent 1px); background-size: 26px 26px; }
.mk-xc-avatar { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -58%); width: 86px; height: 86px; border-radius: 50%; border: 3px solid rgba(255,255,255,.2); box-shadow: 0 8px 32px rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; font-size: 26px; font-weight: 700; color: rgba(255,255,255,.92); letter-spacing: -.5px; }
.mk-xc-fade { position: absolute; left: 0; right: 0; bottom: 0; height: 56%; background: linear-gradient(to top, rgba(10,22,40,.95) 0%, rgba(10,22,40,.6) 55%, transparent 100%); }
.mk-xc-meta { position: absolute; left: 0; right: 0; bottom: 0; padding: 0 16px 13px; display: flex; align-items: flex-end; justify-content: space-between; color: #fff; }
.mk-xc-name { font-size: 16px; font-weight: 700; letter-spacing: -.2px; display: flex; align-items: center; gap: 5px; }
.mk-xc-stars { display: flex; align-items: center; gap: 5px; margin-top: 3px; font-size: 11px; color: rgba(255,255,255,.7); font-weight: 500; }
.mk-xc-stars em { font-style: normal; opacity: .6; }
.mk-xc-rate { text-align: right; }
.mk-xc-rate-val { font-size: 19px; font-weight: 600; line-height: 1; letter-spacing: -.5px; }
.mk-xc-rate-unit { font-size: 10px; color: rgba(255,255,255,.5); margin-top: 2px; }
.mk-xc-avail { position: absolute; top: 12px; left: 12px; display: flex; align-items: center; gap: 5px; padding: 3px 8px 3px 7px; border-radius: 20px; background: rgba(5,150,105,.85); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); border: 1px solid rgba(52,211,153,.4); font-size: 10px; font-weight: 700; color: #fff; }
.mk-xc-avail.off { background: rgba(255,255,255,.12); border-color: rgba(255,255,255,.2); }
.mk-xc-avail-dot { width: 6px; height: 6px; border-radius: 50%; background: #34D399; animation: mk-pulse 2s ease infinite; }
.mk-xc-body { padding: 14px 16px 0; flex: 1; }
.mk-xc-title { font-size: 12.5px; line-height: 1.45; margin: 0 0 10px; }
.mk-xc-title strong { font-weight: 650; }
.mk-xc-title span { color: var(--text3); }
.mk-xc-bio { margin: 0 0 10px; padding: 8px 10px 8px 12px; border-radius: 8px; background: var(--mist); border-left: 2.5px solid #BFDBFE; font-size: 11.5px; color: var(--text2); font-style: italic; line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.mk-xc-stats { display: flex; border-top: 1px solid var(--line-soft); border-bottom: 1px solid var(--line-soft); padding: 9px 0; }
.mk-xc-stat { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; border-right: 1px solid var(--line-soft); font-size: 10px; font-weight: 550; color: var(--text2); white-space: nowrap; }
.mk-xc-stat:last-child { border-right: none; }
.mk-xc-pills { display: flex; flex-wrap: wrap; gap: 6px; padding: 11px 0 6px; align-items: center; }
.mk-xc-pill { padding: 5px 10px; border-radius: 20px; background: rgba(37,99,235,.07); border: 1px solid rgba(37,99,235,.18); font-size: 11px; font-weight: 650; color: var(--primary); }
.mk-xc-more { font-size: 11px; font-weight: 600; color: var(--primary); }
.mk-xc-ctas { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 10px 16px 16px; }
.mk-xc-ctas .mk-btn { border-radius: 10px; font-size: 13px; padding: 0 12px; }
@media (max-width: 900px) { .mk-experts { grid-template-columns: 1fr 1fr; } }
@media (max-width: 600px) { .mk-experts { grid-template-columns: 1fr; } }

/* ── Pricing ── */
.mk-price { display: grid; grid-template-columns: 1.05fr 1fr; gap: 64px; align-items: center; }
.mk-price-list { list-style: none; padding: 0; margin: 28px 0 0; display: flex; flex-direction: column; gap: 16px; }
.mk-price-list li { display: flex; gap: 14px; align-items: flex-start; font-size: 15px; color: var(--text2); line-height: 1.5; }
.mk-price-list li strong { color: var(--ink); font-weight: 600; display: block; margin-bottom: 2px; }
.mk-tick { width: 22px; height: 22px; border-radius: 50%; background: rgba(37,99,235,.1); color: var(--primary); display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px; }
.mk-price-nos { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 28px; }
.mk-no { font-family: var(--mono); font-size: 12px; padding: 6px 11px; border-radius: 8px; background: #fff; border: 1px solid var(--line); color: var(--text2); }
.mk-receipt-wrap { position: relative; display: flex; justify-content: center; }
.mk-receipt-glow { position: absolute; inset: 18% 12%; background: var(--grad); filter: blur(60px); opacity: .18; border-radius: 40px; }
.mk-receipt { position: relative; width: 360px; max-width: 100%; background: #fff; border-radius: 20px; border: 1px solid var(--line); box-shadow: 0 30px 60px -30px rgba(17,24,39,.35), 0 2px 6px rgba(17,24,39,.06); padding: 22px; will-change: transform; }
.mk-rc-head { display: flex; justify-content: space-between; align-items: center; }
.mk-rc-kicker { font-family: var(--mono); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--text3); }
.mk-rc-paid { font-size: 11px; font-weight: 700; color: var(--success); background: rgba(5,150,105,.1); padding: 4px 8px; border-radius: 999px; }
.mk-rc-who { display: flex; gap: 12px; align-items: center; margin: 16px 0 12px; }
.mk-rc-who strong { display: block; font-size: 14px; font-weight: 600; }
.mk-rc-who span { font-size: 12.5px; color: var(--text2); }
.mk-rc-row { display: flex; justify-content: space-between; font-size: 14px; padding: 10px 0; border-top: 1px solid var(--line-soft); color: var(--text2); }
.mk-rc-row .mk-mono { color: var(--ink); font-weight: 500; }
.mk-rc-total { display: flex; justify-content: space-between; align-items: baseline; padding-top: 14px; margin-top: 2px; border-top: 1px dashed var(--line); font-weight: 600; }
.mk-rc-total-val { font-family: var(--mono); font-size: 28px; font-weight: 600; letter-spacing: -.03em; }
.mk-rc-foot { font-size: 12px; color: var(--text3); margin-top: 12px; font-family: var(--mono); }
@media (max-width: 900px) { .mk-price { grid-template-columns: 1fr; gap: 44px; } }

/* ── Expert band (dark) ── */
.mk-xband { position: relative; background: var(--night); color: #fff; overflow: hidden; padding: 108px 0; }
.mk-xband-glow { position: absolute; width: 900px; height: 900px; right: -320px; top: -320px; border-radius: 50%; background: radial-gradient(circle, rgba(124,58,237,.38), transparent 60%); filter: blur(30px); will-change: transform; pointer-events: none; }
.mk-xband-glow2 { right: auto; top: auto; left: -340px; bottom: -420px; background: radial-gradient(circle, rgba(37,99,235,.3), transparent 60%); }
.mk-xband-grid { position: absolute; inset: 0; opacity: .07; background-image: radial-gradient(rgba(255,255,255,.7) .8px, transparent .9px); background-size: 26px 26px; pointer-events: none; }
.mk-xband-inner { position: relative; display: grid; grid-template-columns: 1.05fr 1fr; gap: 56px; align-items: center; }
.mk-xband .mk-eyebrow { color: #A5B4FC; }
.mk-xband .mk-h2 { color: #fff; }
.mk-xband .mk-sub { color: rgba(255,255,255,.7); }
.mk-xband-ctas { display: flex; gap: 10px; margin-top: 30px; flex-wrap: wrap; }
.mk-perks { display: grid; gap: 12px; }
.mk-perk { display: flex; gap: 14px; padding: 16px 18px; border-radius: 16px; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.09); transition: background .2s, border-color .2s, transform .25s var(--ease); }
.mk-perk:hover { background: rgba(255,255,255,.08); border-color: rgba(255,255,255,.16); transform: translateX(4px); }
.mk-perk-icon { width: 38px; height: 38px; border-radius: 11px; background: rgba(255,255,255,.08); display: flex; align-items: center; justify-content: center; color: #C4B5FD; flex-shrink: 0; }
.mk-perk strong { display: block; font-size: 15px; font-weight: 600; margin-bottom: 2px; }
.mk-perk span { font-size: 13.5px; color: rgba(255,255,255,.65); line-height: 1.5; }
@media (max-width: 900px) { .mk-xband { padding: 72px 0; } .mk-xband-inner { grid-template-columns: 1fr; gap: 36px; } }

/* ── Testimonials ── */
.mk-quotes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
.mk-quote { background: #fff; border: 1px solid var(--line); border-radius: 20px; padding: 26px; display: flex; flex-direction: column; gap: 16px; margin: 0; transition: transform .3s var(--ease), box-shadow .3s var(--ease); }
.mk-quote:hover { transform: translateY(-3px); box-shadow: 0 20px 40px -24px rgba(17,24,39,.25); }
.mk-stars { display: flex; gap: 2px; color: var(--amber); }
.mk-quote p { font-size: 15.5px; line-height: 1.55; margin: 0; flex: 1; }
.mk-quote-who { display: flex; gap: 12px; align-items: center; }
.mk-quote-name { font-size: 14px; font-weight: 600; }
.mk-quote-role { font-size: 12.5px; color: var(--text2); }
.mk-quote-ctx { font-family: var(--mono); font-size: 11px; color: var(--text3); border-top: 1px solid var(--line-soft); padding-top: 12px; }
@media (max-width: 900px) { .mk-quotes { grid-template-columns: 1fr; } }

/* ── Final CTA ── */
.mk-final { padding: 0 0 100px; }
.mk-final-card { position: relative; overflow: hidden; border-radius: 28px; background: var(--grad); color: #fff; padding: 76px 48px; text-align: center; }
.mk-final-card::before { content: ''; position: absolute; inset: 0; background: radial-gradient(circle at 18% 20%, rgba(255,255,255,.2), transparent 45%), radial-gradient(circle at 85% 85%, rgba(255,255,255,.14), transparent 40%); }
.mk-final-grid { position: absolute; inset: 0; opacity: .14; background-image: radial-gradient(rgba(255,255,255,.9) .8px, transparent .9px); background-size: 24px 24px; }
.mk-final h2 { position: relative; font-size: clamp(30px, 4vw, 48px); letter-spacing: -.03em; line-height: 1.05; margin: 0 0 14px; text-wrap: balance; }
.mk-final p { position: relative; font-size: 17px; color: rgba(255,255,255,.84); margin: 0 auto 30px; max-width: 520px; }
.mk-final-ctas { position: relative; display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
@media (max-width: 720px) { .mk-final { padding-bottom: 64px; } .mk-final-card { padding: 52px 24px; border-radius: 22px; } }

/* ── Footer ── */
.mk-footer { border-top: 1px solid var(--line); padding: 56px 0 32px; background: #fff; }
.mk-footer-grid { display: grid; grid-template-columns: 1.6fr repeat(4, 1fr); gap: 32px; }
.mk-footer-brand p { font-size: 14px; color: var(--text2); max-width: 260px; margin: 12px 0 0; line-height: 1.55; }
.mk-footer h4 { font-size: 11.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--text3); margin: 0 0 14px; font-family: var(--mono); font-weight: 500; }
.mk-footer ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 9px; }
.mk-footer li a { font-size: 14px; color: var(--text2); text-decoration: none; transition: color .15s; }
.mk-footer li a:hover { color: var(--ink); }
.mk-footer-bottom { display: flex; justify-content: space-between; align-items: center; margin-top: 48px; padding-top: 22px; border-top: 1px solid var(--line-soft); font-size: 13px; color: var(--text3); flex-wrap: wrap; gap: 12px; }
.mk-footer-bottom nav { display: flex; gap: 18px; }
.mk-footer-bottom nav a { text-decoration: none; color: var(--text3); }
.mk-footer-bottom nav a:hover { color: var(--ink); }
@media (max-width: 900px) { .mk-footer-grid { grid-template-columns: 1fr 1fr; } .mk-footer-brand { grid-column: 1 / -1; } }

/* ── Reduced motion ── */
.mk-page.reduced .mk-blob, .mk-page.reduced .mk-live-dot, .mk-page.reduced .mk-xc-avail-dot { animation: none; }
.mk-page.reduced .mk-hero-inner > *, .mk-page.reduced .mk-bench { animation: none; }
.mk-page.reduced .mk-underline path { animation: none; stroke-dashoffset: 0; }
.mk-page.reduced .mk-reveal { opacity: 1; transform: none; transition: none; }
.mk-page.reduced .mk-facet-pop { animation: none; }
.mk-page.reduced .mk-steps-progress { transition: none; transform: scaleX(1); }
.mk-page.reduced .mk-step-dot { transition: none; }
.mk-page.reduced .mk-nav-link::after, .mk-page.reduced .mk-btn, .mk-page.reduced .mk-way, .mk-page.reduced .mk-tile, .mk-page.reduced .mk-chip, .mk-page.reduced .mk-pchip, .mk-page.reduced .mk-facet { transition-duration: .01s; }

/* ── Keyframes ── */
@keyframes mk-up { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
@keyframes mk-drop { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
@keyframes mk-draw { to { stroke-dashoffset: 0; } }
@keyframes mk-blink { to { opacity: 0; } }
@keyframes mk-ping { 0% { box-shadow: 0 0 0 0 rgba(52,211,153,.55); } 70% { box-shadow: 0 0 0 8px rgba(52,211,153,0); } 100% { box-shadow: 0 0 0 0 rgba(52,211,153,0); } }
@keyframes mk-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }
@keyframes mk-drift-a { from { transform: translate3d(0,0,0); } to { transform: translate3d(70px, 50px, 0); } }
@keyframes mk-drift-b { from { transform: translate3d(0,0,0); } to { transform: translate3d(-60px, 70px, 0); } }
@keyframes mk-drift-c { from { transform: translate3d(0,0,0) scale(1); } to { transform: translate3d(40px, -40px, 0) scale(1.12); } }
`;

// ── Inline SVG icons (Lucide, stroke 2, round caps) ────────────────
const Svg = ({ size = 16, color = 'currentColor', className, children }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    {children}
  </svg>
);
const I = {
  search: (p) => (
    <Svg {...p}>
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.3-4.3" />
    </Svg>
  ),
  arrow: (p) => (
    <Svg {...p} className="mk-arrow">
      <path d="M5 12h14" />
      <path d="M12 5l7 7-7 7" />
    </Svg>
  ),
  arrowPlain: (p) => (
    <Svg {...p}>
      <path d="M5 12h14" />
      <path d="M12 5l7 7-7 7" />
    </Svg>
  ),
  check: (p) => (
    <Svg {...p}>
      <path d="M20 6L9 17l-5-5" />
    </Svg>
  ),
  star: ({ fill, ...p }) => (
    <Svg {...p}>
      <polygon
        points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
        fill={fill || 'none'}
      />
    </Svg>
  ),
  video: (p) => (
    <Svg {...p}>
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" />
    </Svg>
  ),
  layers: (p) => (
    <Svg {...p}>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </Svg>
  ),
  box: (p) => (
    <Svg {...p}>
      <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </Svg>
  ),
  mapPin: (p) => (
    <Svg {...p}>
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
      <circle cx="12" cy="10" r="3" />
    </Svg>
  ),
  award: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="8" r="7" />
      <polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88" />
    </Svg>
  ),
  briefcase: (p) => (
    <Svg {...p}>
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" />
    </Svg>
  ),
  user: (p) => (
    <Svg {...p}>
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </Svg>
  ),
  menu: (p) => (
    <Svg {...p}>
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </Svg>
  ),
  x: (p) => (
    <Svg {...p}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </Svg>
  ),
  clock: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </Svg>
  ),
  calendar: (p) => (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </Svg>
  ),
  banknote: (p) => (
    <Svg {...p}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2" />
      <path d="M6 12h.01M18 12h.01" />
    </Svg>
  ),
  shield: (p) => (
    <Svg {...p}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </Svg>
  ),
  users: (p) => (
    <Svg {...p}>
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87" />
      <path d="M16 3.13a4 4 0 010 7.75" />
    </Svg>
  ),
  linkedin: (p) => (
    <Svg {...p}>
      <path d="M16 8a6 6 0 016 6v7h-4v-7a2 2 0 00-2-2 2 2 0 00-2 2v7h-4v-7a6 6 0 016-6z" />
      <rect x="2" y="9" width="4" height="12" />
      <circle cx="4" cy="4" r="2" />
    </Svg>
  ),
  chev: (p) => (
    <Svg {...p}>
      <polyline points="6 9 12 15 18 9" />
    </Svg>
  ),
  // Product-mark glyphs (neutral stand-ins — see OPEN QUESTIONS #1)
  trending: (p) => (
    <Svg {...p}>
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
      <polyline points="17 6 23 6 23 12" />
    </Svg>
  ),
  headset: (p) => (
    <Svg {...p}>
      <path d="M3 18v-6a9 9 0 0118 0v6" />
      <path d="M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zM3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3z" />
    </Svg>
  ),
  megaphone: (p) => (
    <Svg {...p}>
      <path d="M3 11l18-5v12L3 14v-3z" />
      <path d="M11.6 16.8a3 3 0 11-5.8-1.6" />
    </Svg>
  ),
  globe: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
    </Svg>
  ),
  bag: (p) => (
    <Svg {...p}>
      <path d="M6 2l-3 5v13a2 2 0 002 2h14a2 2 0 002-2V7l-3-5z" />
      <line x1="3" y1="7" x2="21" y2="7" />
      <path d="M16 11a4 4 0 01-8 0" />
    </Svg>
  ),
  database: (p) => (
    <Svg {...p}>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </Svg>
  ),
  sparkles: (p) => (
    <Svg {...p}>
      <path d="M12 3l1.9 5.8a2 2 0 001.3 1.3L21 12l-5.8 1.9a2 2 0 00-1.3 1.3L12 21l-1.9-5.8a2 2 0 00-1.3-1.3L3 12l5.8-1.9a2 2 0 001.3-1.3L12 3z" />
    </Svg>
  ),
  chart: (p) => (
    <Svg {...p}>
      <line x1="12" y1="20" x2="12" y2="10" />
      <line x1="18" y1="20" x2="18" y2="4" />
      <line x1="6" y1="20" x2="6" y2="16" />
    </Svg>
  ),
  gitMerge: (p) => (
    <Svg {...p}>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 009 9" />
    </Svg>
  ),
  hash: (p) => (
    <Svg {...p}>
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="14" y2="21" />
    </Svg>
  ),
  wrench: (p) => (
    <Svg {...p}>
      <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
    </Svg>
  ),
  mail: (p) => (
    <Svg {...p}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M22 7l-10 6L2 7" />
    </Svg>
  ),
  landmark: (p) => (
    <Svg {...p}>
      <line x1="3" y1="22" x2="21" y2="22" />
      <line x1="6" y1="18" x2="6" y2="11" />
      <line x1="10" y1="18" x2="10" y2="11" />
      <line x1="14" y1="18" x2="14" y2="11" />
      <line x1="18" y1="18" x2="18" y2="11" />
      <polygon points="12 2 20 7 4 7" />
    </Svg>
  ),
  activity: (p) => (
    <Svg {...p}>
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </Svg>
  ),
  heart: (p) => (
    <Svg {...p}>
      <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" />
    </Svg>
  ),
  code: (p) => (
    <Svg {...p}>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </Svg>
  ),
  zap: (p) => (
    <Svg {...p}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </Svg>
  ),
};

// ── Avatar helpers (same hash + gradients as ExpertCard, BAL-214) ──
const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #0F4C81 0%, #2a7fd4 100%)',
  'linear-gradient(135deg, #1e3a5f 0%, #0F4C81 100%)',
  'linear-gradient(135deg, #3b0764 0%, #7C3AED 100%)',
  'linear-gradient(135deg, #064e3b 0%, #059669 100%)',
  'linear-gradient(135deg, #7c2d12 0%, #ea580c 100%)',
  'linear-gradient(135deg, #1e1b4b 0%, #4F46E5 100%)',
];
const avatarGradient = (key) =>
  AVATAR_GRADIENTS[
    key.split('').reduce((a, ch) => a + ch.charCodeAt(0), 0) % AVATAR_GRADIENTS.length
  ];
const initials = (name) =>
  name
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

// ── Sample data (ALL PLACEHOLDER — see header) ─────────────────────
const LIVE_COUNT = 38;

// Product-coverage bench (tile marks are NEUTRAL glyphs — see OPEN
// QUESTIONS #1 re: real Salesforce product logos). Counts PLACEHOLDER.
const TINTS = {
  blue: { bg: '#EFF6FF', fg: '#2563EB' },
  violet: { bg: '#F5F3FF', fg: '#7C3AED' },
  teal: { bg: '#ECFDF5', fg: '#059669' },
  amber: { bg: '#FFFBEB', fg: '#D97706' },
  slate: { bg: '#F1F5F9', fg: '#475569' },
};
const PRODUCTS = [
  { id: 'sales', name: 'Sales Cloud', icon: 'trending', tint: 'blue', count: 140 },
  { id: 'service', name: 'Service Cloud', icon: 'headset', tint: 'violet', count: 120 },
  { id: 'agentforce', name: 'Agentforce', icon: 'sparkles', tint: 'violet', count: 45 },
  { id: 'data', name: 'Data Cloud', icon: 'database', tint: 'blue', count: 70 },
  { id: 'cpq', name: 'Revenue Cloud & CPQ', icon: 'banknote', tint: 'teal', count: 80 },
  { id: 'marketing', name: 'Marketing Cloud', icon: 'megaphone', tint: 'amber', count: 95 },
  { id: 'platform', name: 'Platform & Apex', icon: 'code', tint: 'slate', count: 110 },
  { id: 'experience', name: 'Experience Cloud', icon: 'globe', tint: 'blue', count: 60 },
  { id: 'tableau', name: 'Tableau & CRM Analytics', icon: 'chart', tint: 'amber', count: 55 },
  { id: 'flow', name: 'Flow & Automation', icon: 'zap', tint: 'amber', count: 115 },
  { id: 'mulesoft', name: 'MuleSoft', icon: 'gitMerge', tint: 'blue', count: 50 },
  { id: 'field', name: 'Field Service', icon: 'wrench', tint: 'slate', count: 40 },
  { id: 'pardot', name: 'Account Engagement', icon: 'mail', tint: 'teal', count: 60 },
  { id: 'commerce', name: 'Commerce Cloud', icon: 'bag', tint: 'violet', count: 45 },
  { id: 'fsc', name: 'Financial Services Cloud', icon: 'landmark', tint: 'teal', count: 35 },
  { id: 'slack', name: 'Slack', icon: 'hash', tint: 'violet', count: 30 },
  { id: 'health', name: 'Health Cloud', icon: 'activity', tint: 'teal', count: 30 },
  { id: 'nonprofit', name: 'Nonprofit Cloud', icon: 'heart', tint: 'amber', count: 35 },
];

const METRICS = [
  { value: 1, prefix: 'Top ', suffix: '%', label: 'of applicants accepted' },
  { value: 4.9, decimals: 1, label: 'average session rating' },
  { value: 2, prefix: '< ', suffix: ' hrs', label: 'typical wait for a first session' },
  { value: 40, suffix: '+', label: 'countries with active experts' },
];

const WAYS = [
  {
    icon: I.video,
    kicker: 'By the minute',
    title: 'Consultations',
    tag: 'From A$1.20/min',
    link: 'Find an expert',
    body: 'Screen-share with an expert and fix it together. The clock runs only while you are both in the room, so a 20-minute problem costs 20 minutes.',
  },
  {
    icon: I.layers,
    kicker: 'Fixed scope',
    title: 'Projects',
    tag: 'Proposal in ~2 days',
    link: 'Post a project',
    body: 'Describe the outcome you need and get a proposal with milestones and a statement of work. You pay as each milestone lands.',
  },
  {
    icon: I.box,
    kicker: 'Set price',
    title: 'Packages',
    tag: 'Fixed price',
    link: 'Browse packages',
    body: 'Org health checks, security reviews, migrations and more, defined up front at a set price, so you can start without a scoping call.',
  },
];

const STEPS = [
  {
    n: '01',
    t: 'Say what is going on',
    d: 'Type it the way you would tell a colleague. We map it to the right products and skills.',
  },
  {
    n: '02',
    t: 'Meet your match',
    d: 'See vetted experts ranked for your problem, with rates, availability and reviews up front.',
  },
  {
    n: '03',
    t: 'Book the time you need',
    d: 'Pick a slot that works and a duration you are comfortable with. Reschedule any time before it starts.',
  },
  {
    n: '04',
    t: 'Get it done, pay to the minute',
    d: 'Fix it live on a screen-share. When you leave, you are billed for the minutes used and nothing else.',
  },
];

const VET = [
  {
    icon: I.shield,
    t: 'Certifications verified',
    d: 'Checked against Salesforce records, not a CV.',
  },
  { icon: I.users, t: 'Technical interview', d: 'With a senior expert in the same discipline.' },
  { icon: I.video, t: 'Live scenario', d: 'A real org, a real problem, on the clock.' },
  { icon: I.star, t: 'Rated every session', d: 'Ratings stay visible. Standards stay high.' },
];

const EXPERTS = [
  {
    id: 'usr_priya',
    name: 'Priya Nair',
    title: 'Data Cloud & Agentforce Architect',
    location: 'Australia',
    years: 11,
    certs: 18,
    sessions: 63,
    rating: 4.9,
    reviews: 41,
    rate: 2.4,
    available: true,
    expertise: ['Data Cloud', 'Agentforce', 'Sales Cloud', 'Integrations', 'Tableau'],
    bio: 'Ex-Salesforce solution architect. I have led Data Cloud and Agentforce rollouts for retail and financial services teams, and I am happiest untangling the integrations everyone else avoids.',
  },
  {
    id: 'usr_diego',
    name: 'Diego Ferreira',
    title: 'Senior Apex & Integrations Developer',
    location: 'Portugal',
    years: 8,
    certs: 9,
    sessions: 120,
    rating: 5.0,
    reviews: 58,
    rate: 2.1,
    available: true,
    expertise: ['Apex', 'Integrations', 'LWC', 'MuleSoft'],
    bio: 'Backend-first Salesforce developer. Triggers, batch jobs, REST and SOAP integrations, and the occasional governor-limit rescue. That is my lane.',
  },
  {
    id: 'usr_mei',
    name: 'Mei-Ling Chao',
    title: 'Service Cloud Consultant & Flow Specialist',
    location: 'Singapore',
    years: 7,
    certs: 12,
    sessions: 84,
    rating: 4.8,
    reviews: 37,
    rate: 1.6,
    available: false,
    next: 'Tomorrow 9:00',
    expertise: ['Service Cloud', 'Flow', 'Experience Cloud', 'Knowledge'],
    bio: 'I help support teams get more out of Service Cloud: case routing, omni-channel, knowledge and the Flows that hold it all together.',
  },
];

const PRICE_POINTS = [
  {
    t: 'Service fee included',
    d: "The rate on an expert's profile already includes Balo's service fee. Nothing is added at checkout.",
  },
  {
    t: 'Billed to the minute',
    d: 'The session timer starts when you both join and stops when you leave. Twenty-three minutes costs twenty-three minutes.',
  },
  {
    t: 'Pay per session or top up credits',
    d: 'Add a card and pay as you go, or hold credits for your team and see spend in one place.',
  },
];
const NOS = ['No retainer', 'No minimum booking', 'No day rate', 'No contract'];

const PERKS = [
  {
    icon: I.clock,
    t: 'Your rate, your hours',
    d: 'Set a per-minute rate and a weekly schedule. Change either whenever you like.',
  },
  {
    icon: I.users,
    t: 'Clients come pre-qualified',
    d: 'Every request is scoped before it reaches you, so sessions start with context, not discovery.',
  },
  {
    icon: I.banknote,
    t: 'Paid in your currency',
    d: 'Sessions and milestones pay out to your local account. No invoicing, no chasing.',
  },
  {
    icon: I.shield,
    t: 'Only the top 1% get in',
    d: 'Certification checks, a technical interview and a live scenario. A high bar, on purpose.',
  },
];

const QUOTES = [
  {
    q: 'Our lead routing had been broken for a month and two agencies quoted a fortnight. Tom fixed it on a screen-share in 35 minutes.',
    name: 'Jordan Lee',
    role: 'RevOps Lead · mid-market SaaS',
    ctx: 'Consultation · 35 min · Sales Cloud',
  },
  {
    q: 'We ran a Data Cloud pilot as a Project. Proposal in two days, delivered in five weeks, milestone billing the whole way. Zero surprises.',
    name: 'Casey Morgan',
    role: 'Head of CRM · retail',
    ctx: 'Project · 5 weeks · Data Cloud',
  },
  {
    q: 'Paying by the minute changed how we use consultants. We ask the small questions now instead of saving them up for a paid workshop.',
    name: 'Alex Rivera',
    role: 'Salesforce Admin · nonprofit',
    ctx: 'Consultation · 18 min · Flow',
  },
];

const FOOTER = [
  { h: 'Product', links: ['Find experts', 'How it works', 'Pricing', 'Packages', 'Projects'] },
  { h: 'Experts', links: ['Apply to join', 'How vetting works', 'Payouts', 'Expert help centre'] },
  { h: 'Company', links: ['About', 'Careers', 'Contact', 'Trust & security'] },
  { h: 'Resources', links: ['Help centre', 'Blog', 'Status'] },
];

// ── Motion context + hooks ─────────────────────────────────────────
const MotionCtx = createContext(false);
const useReduced = () => useContext(MotionCtx);

function usePrefersReduced() {
  const [v, setV] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setV(mq.matches);
    on();
    mq.addEventListener ? mq.addEventListener('change', on) : mq.addListener(on);
    return () =>
      mq.removeEventListener ? mq.removeEventListener('change', on) : mq.removeListener(on);
  }, []);
  return v;
}

// One IntersectionObserver per group; fires once.
function useInView(reduced, threshold = 0.12) {
  const ref = useRef(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (reduced) {
      setInView(true);
      return;
    }
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold, rootMargin: '0px 0px -8% 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduced, threshold]);
  return [ref, inView];
}

function Reveal({ as: Tag = 'div', className = '', children, ...rest }) {
  const reduced = useReduced();
  const [ref, inView] = useInView(reduced);
  return (
    <Tag ref={ref} className={`mk-reveal-group${inView ? ' is-in' : ''} ${className}`} {...rest}>
      {children}
    </Tag>
  );
}

// Scroll-linked transform, written straight to the DOM (no re-renders).
// `compute(scrollY, parentRect, viewportH)` returns a transform string.
// Measures the PARENT so the element's own transform can't feed back.
function useScrollFx(compute, reduced) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduced) {
      el.style.transform = '';
      return;
    }
    let raf = 0;
    const run = () => {
      raf = 0;
      const base = el.parentElement || el;
      el.style.transform = compute(
        window.scrollY || 0,
        base.getBoundingClientRect(),
        window.innerHeight || 800
      );
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(run);
    };
    run();
    window.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => {
      window.removeEventListener('scroll', on);
      window.removeEventListener('resize', on);
      if (raf) cancelAnimationFrame(raf);
      el.style.transform = '';
    };
  }, [compute, reduced]);
  return ref;
}
// Bench rows: slide sideways with the first ~900px of scroll, drift up a touch.
const fxBench = (dir) => (y) => {
  const s = Math.min(y, 900);
  return `translate3d(${(s * 0.22 * dir).toFixed(1)}px, ${(s * -0.06).toFixed(1)}px, 0)`;
};
// Float against scroll, relative to the element's distance from viewport centre.
const fxFloat = (factor) => (y, r, vh) => {
  const centre = r.top + r.height / 2 - vh / 2;
  return `translate3d(0, ${(centre * factor).toFixed(1)}px, 0)`;
};
const FX_BENCH_A = fxBench(-1);
const FX_BENCH_B = fxBench(1);
const FX_RECEIPT = fxFloat(0.08);
const FX_GLOW_A = fxFloat(0.12);
const FX_GLOW_B = fxFloat(-0.08);

function useTypewriter(phrases, reduced) {
  const [text, setText] = useState(reduced ? phrases[0] : '');
  useEffect(() => {
    if (reduced) {
      setText(phrases[0]);
      return;
    }
    let i = 0,
      j = 0,
      deleting = false,
      t;
    const tick = () => {
      const p = phrases[i];
      if (!deleting) {
        j += 1;
        setText(p.slice(0, j));
        if (j === p.length) {
          deleting = true;
          t = setTimeout(tick, 2000);
          return;
        }
        t = setTimeout(tick, 32 + Math.random() * 34);
      } else {
        j -= 1;
        setText(p.slice(0, j));
        if (j === 0) {
          deleting = false;
          i = (i + 1) % phrases.length;
          t = setTimeout(tick, 360);
          return;
        }
        t = setTimeout(tick, 14);
      }
    };
    t = setTimeout(tick, 900);
    return () => clearTimeout(t);
  }, [phrases, reduced]);
  return text;
}

function useCountUp(target, active, reduced, decimals = 0, duration = 1400) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!active) return;
    if (reduced) {
      setV(target);
      return;
    }
    let raf, start;
    const step = (ts) => {
      if (!start) start = ts;
      const p = Math.min(1, (ts - start) / duration);
      const e = 1 - Math.pow(1 - p, 3);
      setV(target * e);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, active, reduced, duration]);
  return v.toFixed(decimals);
}

// ─────────────────────────────────────────────────────────────────
// SMALL PARTS
// ─────────────────────────────────────────────────────────────────
function Stars({ rating, size = 10, color = '#F59E0B' }) {
  return (
    <span style={{ display: 'inline-flex', gap: 1 }}>
      {[1, 2, 3, 4, 5].map((k) => (
        <I.star key={k} size={size} color={color} fill={k <= Math.floor(rating) ? color : 'none'} />
      ))}
    </span>
  );
}

// The "timer bar" underline. pathLength=1 so the draw is unit-based.
function Underline() {
  return (
    <svg
      className="mk-underline"
      viewBox="0 0 300 14"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="mkUnderline" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#2563EB" />
          <stop offset="1" stopColor="#7C3AED" />
        </linearGradient>
      </defs>
      <path
        d="M3 9 C 70 3, 150 3, 297 8"
        fill="none"
        stroke="url(#mkUnderline)"
        strokeWidth="5"
        strokeLinecap="round"
        pathLength="1"
        style={{ strokeDasharray: 1, strokeDashoffset: 1 }}
      />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────
// CONTROL STRIP (prototype only)
// ─────────────────────────────────────────────────────────────────
const Seg = ({ value, onChange, options }) => (
  <div className="mk-seg">
    {options.map((o) => (
      <button key={o} type="button" className={value === o ? 'on' : ''} onClick={() => onChange(o)}>
        {o}
      </button>
    ))}
  </div>
);
function ControlStrip({ hero, setHero, motion, setMotion, prefersReduced }) {
  return (
    <div className="mk-ctl">
      <div className="mk-ctl-title">
        Balo marketing home <span>· design reference v1 · balo.expert</span>
      </div>
      <div className="mk-ctl-group">
        <span className="mk-ctl-label">Hero</span>
        <Seg value={hero} onChange={setHero} options={['light', 'deep']} />
      </div>
      <div className="mk-ctl-group">
        <span className="mk-ctl-label">Motion</span>
        <Seg value={motion} onChange={setMotion} options={['full', 'reduced']} />
        {prefersReduced && <span className="mk-ctl-note">OS prefers reduced</span>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// NAV — transparent over the hero, frosted glass after 24px
// ─────────────────────────────────────────────────────────────────
const NAV_LINKS = [
  ['Find experts', '#experts'],
  ['How it works', '#how'],
  ['Pricing', '#pricing'],
  ['For experts', '#for-experts'],
];

function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const f = () => setScrolled((window.scrollY || 0) > 24);
    f();
    window.addEventListener('scroll', f, { passive: true });
    return () => window.removeEventListener('scroll', f);
  }, []);
  return (
    <header className={`mk-nav${scrolled || open ? ' is-scrolled' : ''}`}>
      <div className="mk-wrap mk-nav-inner">
        {/* Logo mark is a stand-in — swap for the real asset */}
        <a className="mk-logo" href="#top" aria-label="Balo home">
          <span className="mk-logo-mark" />
          Balo
        </a>
        <nav className="mk-nav-links" aria-label="Primary">
          {NAV_LINKS.map(([l, h]) => (
            <a key={h} className="mk-nav-link" href={h}>
              {l}
            </a>
          ))}
        </nav>
        <div className="mk-nav-right">
          <a className="mk-btn mk-btn-text mk-nav-login" href="#top">
            Log in
          </a>
          <a className="mk-btn mk-btn-solid" href="#experts">
            Find an expert
          </a>
          <button
            type="button"
            className="mk-burger"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={open ? 'Close menu' : 'Open menu'}
          >
            {open ? <I.x size={20} /> : <I.menu size={20} />}
          </button>
        </div>
      </div>
      {open && (
        <div className="mk-mnav">
          {NAV_LINKS.map(([l, h]) => (
            <a key={h} className="mk-mnav-link" href={h} onClick={() => setOpen(false)}>
              {l}
            </a>
          ))}
          <a className="mk-mnav-link" href="#top" onClick={() => setOpen(false)}>
            Log in
          </a>
        </div>
      )}
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────
// HERO — headline · composer search (FTS + Product facet) · chips ·
// parallax product-coverage bench
// ─────────────────────────────────────────────────────────────────
function ProductTile({ p }) {
  const t = TINTS[p.tint];
  const Icon = I[p.icon];
  return (
    <div
      className="mk-tile"
      role="link"
      tabIndex={0}
      aria-label={`${p.name} — ${p.count}+ experts`}
    >
      <span className="mk-mark" style={{ background: t.bg, color: t.fg }}>
        <Icon size={19} />
      </span>
      <div>
        <div className="mk-tile-name">{p.name}</div>
        <div className="mk-tile-count">{p.count}+ experts</div>
      </div>
    </div>
  );
}

// Visual stand-in for the BAL-249 ProductSelector (search-composer.jsx):
// mini search + grouped chips + dense-cap "+n more" + tokens summary.
// Prod mounts the real component; omitted here: match highlighting.
function ProductFacet({ products, toggle, clear, open, setOpen }) {
  const [pq, setPq] = useState('');
  const [expanded, setExpanded] = useState({});
  const arr = [...products];
  const summary =
    arr.length === 0 ? 'Any' : arr.length === 1 ? arr[0] : `${arr[0]} +${arr.length - 1}`;
  const filtered = useMemo(() => {
    if (!pq) return TAXONOMY;
    const ql = pq.toLowerCase();
    return TAXONOMY.map((g) => ({
      ...g,
      items: g.items.filter((i) => i.toLowerCase().includes(ql)),
    })).filter((g) => g.items.length > 0 || g.group.toLowerCase().includes(ql));
  }, [pq]);
  return (
    <>
      <button
        type="button"
        className={`mk-facet${open ? ' is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <I.box size={15} />
        <span className="mk-facet-txt">
          <span className="mk-facet-lab">Product</span>
          <span className={`mk-facet-val${arr.length ? ' has' : ''}`}>{summary}</span>
        </span>
        {arr.length > 0 && <span className="mk-facet-badge mk-mono">{arr.length}</span>}
        <I.chev size={14} className={open ? 'mk-rot' : undefined} />
      </button>
      {open && (
        <div className="mk-facet-pop" role="dialog" aria-label="Filter by product">
          <div className="mk-pop-search">
            <I.search size={14} />
            <input
              value={pq}
              onChange={(e) => setPq(e.target.value)}
              placeholder="Search products…"
              aria-label="Search products"
            />
            {pq && (
              <button
                type="button"
                className="mk-pop-x"
                onClick={() => setPq('')}
                aria-label="Clear product search"
              >
                <I.x size={13} />
              </button>
            )}
          </div>
          {arr.length > 0 && (
            <div className="mk-pop-sel">
              <span className="mk-mono">{arr.length} selected</span>
              <button type="button" onClick={clear}>
                Clear all
              </button>
            </div>
          )}
          <div className="mk-pop-scroll">
            {filtered.length === 0 && <p className="mk-pop-none">No products match "{pq}"</p>}
            {filtered.map((g) => {
              const dense = g.items.length > DENSE_CAP && !pq;
              const show = dense && !expanded[g.group] ? g.items.slice(0, DENSE_CAP) : g.items;
              const hidden = g.items.length - show.length;
              return (
                <div key={g.group} className="mk-pop-group">
                  <div className="mk-pop-glab">
                    {g.group}
                    {g.items.length > 1 && <em>{g.items.length}</em>}
                  </div>
                  <div className="mk-pop-chips">
                    {show.map((it) => (
                      <button
                        key={it}
                        type="button"
                        className={`mk-pchip${products.has(it) ? ' on' : ''}`}
                        onClick={() => toggle(it)}
                        aria-pressed={products.has(it)}
                      >
                        {products.has(it) && <I.check size={12} />}
                        {it}
                      </button>
                    ))}
                    {hidden > 0 && (
                      <button
                        type="button"
                        className="mk-pchip mk-pchip-more"
                        onClick={() => setExpanded((x) => ({ ...x, [g.group]: true }))}
                      >
                        +{hidden} more
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

function Hero() {
  const reduced = useReduced();
  const typed = useTypewriter(VERTICAL.phrases, reduced);
  const [q, setQ] = useState('');
  const [products, setProducts] = useState(new Set());
  const [facetOpen, setFacetOpen] = useState(false);
  const searchRef = useRef(null);
  const toggleProduct = (it) =>
    setProducts((prev) => {
      const n = new Set(prev);
      if (n.has(it)) n.delete(it);
      else n.add(it);
      return n;
    });
  useEffect(() => {
    if (!facetOpen) return;
    const down = (e) => {
      if (searchRef.current && !searchRef.current.contains(e.target)) setFacetOpen(false);
    };
    const key = (e) => {
      if (e.key === 'Escape') setFacetOpen(false);
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [facetOpen]);
  const rowA = useScrollFx(FX_BENCH_A, reduced);
  const rowB = useScrollFx(FX_BENCH_B, reduced);
  const half = Math.ceil(PRODUCTS.length / 2);

  return (
    <section className="mk-hero" id="top">
      <div className="mk-hero-bg" aria-hidden="true">
        <div className="mk-blob mk-blob-a" />
        <div className="mk-blob mk-blob-b" />
        <div className="mk-blob mk-blob-c" />
        <div className="mk-grid" />
        <div className="mk-hero-fade" />
      </div>

      <div className="mk-hero-inner">
        <div className="mk-live">
          <span className="mk-live-dot" />
          <span className="mk-mono mk-live-n">{LIVE_COUNT}</span>
          <span>experts available now</span>
        </div>

        <h1 className="mk-h1">
          Top {VERTICAL.name} experts,
          <br />
          <span className="mk-h1-em">
            on demand
            <Underline />
          </span>
          .
        </h1>

        <p className="mk-lede">
          Only the top 1% of applicants make it onto Balo. Book one for a 20-minute fix or a
          six-week build, and pay by the minute. Nothing more.
        </p>

        {/* Production: mount the real SearchComposer unified bar (BAL-249) —
            this mirrors its FTS field + Product facet + submit. */}
        <div className="mk-search" role="search" ref={searchRef}>
          <span className="mk-search-icon">
            <I.search size={20} />
          </span>
          <div className="mk-search-field">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label={`Describe what you need help with in ${VERTICAL.name}`}
            />
            {!q && (
              <span className="mk-search-ghost" aria-hidden="true">
                {typed}
                {!reduced && <span className="mk-caret" />}
              </span>
            )}
          </div>
          <span className="mk-sdiv" aria-hidden="true" />
          <ProductFacet
            products={products}
            toggle={toggleProduct}
            clear={() => setProducts(new Set())}
            open={facetOpen}
            setOpen={setFacetOpen}
          />
          <button type="button" className="mk-btn mk-btn-grad">
            Find experts
            <I.arrow size={16} />
          </button>
        </div>

        <div className="mk-chips">
          <span className="mk-chips-label">Popular:</span>
          {VERTICAL.chips.map((ch) => (
            <button
              key={ch}
              type="button"
              className={`mk-chip${products.has(ch) ? ' on' : ''}`}
              onClick={() => toggleProduct(ch)}
              aria-pressed={products.has(ch)}
            >
              {ch}
            </button>
          ))}
        </div>
      </div>

      {/* Bench — product-coverage tiles, opposite parallax directions */}
      <div className="mk-bench" aria-label={`${VERTICAL.name} products covered by Balo experts`}>
        <div className="mk-bench-row" ref={rowA}>
          {PRODUCTS.slice(0, half).map((p) => (
            <ProductTile key={p.id} p={p} />
          ))}
        </div>
        <div className="mk-bench-row mk-bench-row-b" ref={rowB}>
          {PRODUCTS.slice(half).map((p) => (
            <ProductTile key={p.id} p={p} />
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────
// PROOF BAND — counters (sample numbers)
// ─────────────────────────────────────────────────────────────────
function Metric({ m, active, reduced }) {
  const v = useCountUp(m.value, active, reduced, m.decimals || 0);
  return (
    <div className="mk-proof-item">
      <div className="mk-proof-val">
        {m.prefix}
        {v}
        {m.suffix}
      </div>
      <div className="mk-proof-lab">{m.label}</div>
    </div>
  );
}
function Proof() {
  const reduced = useReduced();
  const [ref, inView] = useInView(reduced, 0.4);
  return (
    <section className="mk-proof" ref={ref}>
      <div className="mk-wrap mk-proof-inner">
        {METRICS.map((m) => (
          <Metric key={m.label} m={m} active={inView} reduced={reduced} />
        ))}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────
// WAYS TO WORK — Consultations · Projects · Packages
// ─────────────────────────────────────────────────────────────────
function Ways() {
  return (
    <section className="mk-section mk-mist" id="ways">
      <Reveal className="mk-wrap">
        <div className="mk-head">
          <div>
            <div className="mk-eyebrow mk-reveal">Ways to work</div>
            <h2 className="mk-h2 mk-reveal" style={{ '--i': 1 }}>
              Three ways to get it done.
            </h2>
            <p className="mk-sub mk-reveal" style={{ '--i': 2 }}>
              Every expert on Balo works all three ways. Start with whichever fits the problem in
              front of you.
            </p>
          </div>
        </div>
        <div className="mk-ways">
          {WAYS.map((w, i) => {
            const Ic = w.icon;
            return (
              <div className="mk-reveal" style={{ '--i': i + 2 }} key={w.title}>
                <article className="mk-way">
                  <div className="mk-way-icon">
                    <Ic size={20} />
                  </div>
                  <div className="mk-way-kicker">{w.kicker}</div>
                  <h3>{w.title}</h3>
                  <p>{w.body}</p>
                  <div className="mk-way-foot">
                    <span className="mk-way-tag">{w.tag}</span>
                    <a className="mk-way-link" href="#experts">
                      {w.link}
                      <I.arrowPlain size={14} />
                    </a>
                  </div>
                </article>
              </div>
            );
          })}
        </div>
      </Reveal>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────
// HOW IT WORKS — a real sequence, so numbering carries meaning.
// Each step gets a tiny product fragment (search → match → slot →
// receipt) so the flow reads as the product, not as marketing.
// ─────────────────────────────────────────────────────────────────
function FragSearch() {
  return (
    <>
      <div className="mk-frag-search">
        <I.search size={13} />
        <span>Lead assignment Flow fails on update…</span>
      </div>
      <span className="mk-frag-tag">Sales Cloud · Flow</span>
    </>
  );
}
function FragMatch() {
  const rows = [
    { id: 'usr_tom', n: 'Tom Okafor', m: 'Flow · A$1.85/min', on: true },
    { id: 'usr_sam', n: 'Sam Whitaker', m: 'Admin · A$1.20/min', on: false },
  ];
  return (
    <>
      {rows.map((r) => (
        <div className={`mk-frag-row${r.on ? ' on' : ''}`} key={r.id}>
          <div className="mk-frag-av" style={{ background: avatarGradient(r.id) }}>
            {initials(r.n)}
          </div>
          <div>
            <div className="mk-frag-name">{r.n}</div>
            <div className="mk-frag-meta">{r.m}</div>
          </div>
          {r.on && (
            <span className="mk-frag-check">
              <I.check size={14} />
            </span>
          )}
        </div>
      ))}
    </>
  );
}
function FragBook() {
  return (
    <>
      <div className="mk-frag-day">Today</div>
      <div className="mk-frag-slots">
        <span className="on">2:30 PM</span>
        <span>3:00 PM</span>
        <span>4:15 PM</span>
      </div>
      <div className="mk-frag-day">Duration</div>
      <div className="mk-frag-slots">
        <span className="on">30 min</span>
        <span>45 min</span>
        <span>60 min</span>
      </div>
    </>
  );
}
function FragDone() {
  return (
    <>
      <div className="mk-frag-line">
        <span>Session ended</span>
        <span className="mk-mono">23 min</span>
      </div>
      <div className="mk-frag-line">
        <span>Total</span>
        <span className="mk-mono">A$42.55</span>
      </div>
      <span className="mk-frag-paid">Paid · fee included</span>
    </>
  );
}
const FRAGS = [FragSearch, FragMatch, FragBook, FragDone];

function HowItWorks() {
  return (
    <section className="mk-section" id="how">
      <Reveal className="mk-wrap">
        <div className="mk-head">
          <div>
            <div className="mk-eyebrow mk-reveal">How it works</div>
            <h2 className="mk-h2 mk-reveal" style={{ '--i': 1 }}>
              From stuck to fixed in four steps.
            </h2>
            <p className="mk-sub mk-reveal" style={{ '--i': 2 }}>
              For a consultation there is no discovery call and nothing to wait on. Describe the
              problem and you can be on a screen-share today.
            </p>
          </div>
        </div>
        <div className="mk-steps">
          <div className="mk-steps-track" />
          <div className="mk-steps-progress" />
          {STEPS.map((s, i) => {
            const Frag = FRAGS[i];
            return (
              <div className="mk-step mk-reveal" style={{ '--i': i + 2 }} key={s.n}>
                <div className="mk-step-dot" />
                <div className="mk-step-num">{s.n}</div>
                <h3>{s.t}</h3>
                <p>{s.d}</p>
                <div className="mk-frag">
                  <Frag />
                </div>
              </div>
            );
          })}
        </div>
      </Reveal>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────
// EXPERTS — vetting strip + spotlight cards
// Cards are a visual stand-in for <ExpertCard> (BAL-214).
// "Book a call" here is a NEW booking touchpoint (marketing home →
// spotlight card → booking) — logged in BAL-277.
// ─────────────────────────────────────────────────────────────────
function SpotlightCard({ e, i }) {
  return (
    <div className="mk-reveal" style={{ '--i': i + 3 }}>
      <article className="mk-xc">
        <div className="mk-xc-hero">
          <div className="mk-xc-texture" />
          <div className="mk-xc-avatar" style={{ background: avatarGradient(e.id) }}>
            {initials(e.name)}
          </div>
          <div className="mk-xc-fade" />
          <div className="mk-xc-meta">
            <div>
              <div className="mk-xc-name">
                {e.name}
                <I.check size={13} color="#34D399" />
              </div>
              <div className="mk-xc-stars">
                <Stars rating={e.rating} />
                <span>
                  {e.rating.toFixed(1)} <em>({e.reviews})</em>
                </span>
              </div>
            </div>
            <div className="mk-xc-rate">
              <div className="mk-xc-rate-val mk-mono">A${e.rate.toFixed(2)}</div>
              <div className="mk-xc-rate-unit">per minute</div>
            </div>
          </div>
          {e.available ? (
            <div className="mk-xc-avail">
              <span className="mk-xc-avail-dot" />
              Available
            </div>
          ) : (
            <div className="mk-xc-avail off">Next: {e.next}</div>
          )}
        </div>
        <div className="mk-xc-body">
          <p className="mk-xc-title">
            <strong>{e.title}</strong> <span>· {e.expertise.slice(0, 3).join(' · ')}</span>
          </p>
          <div className="mk-xc-bio">{e.bio}</div>
          <div className="mk-xc-stats">
            {[
              [I.mapPin, e.location],
              [I.briefcase, `${e.years}y exp`],
              [I.award, `${e.certs} certs`],
              [I.video, `${e.sessions} sessions`],
            ].map(([Ic, l], k) => (
              <div className="mk-xc-stat" key={k}>
                <Ic size={13} color="#2563EB" />
                <span>{l}</span>
              </div>
            ))}
          </div>
          <div className="mk-xc-pills">
            {e.expertise.slice(0, 3).map((p) => (
              <span className="mk-xc-pill" key={p}>
                {p}
              </span>
            ))}
            {e.expertise.length > 3 && (
              <span className="mk-xc-more">+{e.expertise.length - 3} more</span>
            )}
          </div>
        </div>
        <div className="mk-xc-ctas">
          <button type="button" className="mk-btn mk-btn-ghost">
            <I.user size={14} />
            View profile
          </button>
          <button type="button" className="mk-btn mk-btn-grad">
            <I.video size={14} />
            Book a call
          </button>
        </div>
      </article>
    </div>
  );
}

function Experts() {
  return (
    <section className="mk-section mk-mist" id="experts">
      <Reveal className="mk-wrap">
        <div className="mk-head">
          <div>
            <div className="mk-eyebrow mk-reveal">Meet the experts</div>
            <h2 className="mk-h2 mk-reveal" style={{ '--i': 1 }}>
              A few of the top 1%.
            </h2>
            <p className="mk-sub mk-reveal" style={{ '--i': 2 }}>
              Every expert has passed four checks before they can take a booking. Ratings stay on
              their profile for as long as they are on Balo.
            </p>
          </div>
          <a className="mk-head-link mk-reveal" style={{ '--i': 2 }} href="#experts">
            Browse all experts
            <I.arrowPlain size={16} />
          </a>
        </div>
        <div className="mk-vet">
          {VET.map((v, i) => (
            <div className="mk-vet-item mk-reveal" style={{ '--i': i + 2 }} key={v.t}>
              <span className="mk-vet-check">
                <I.check size={12} />
              </span>
              <div>
                <strong>{v.t}</strong>
                <span>{v.d}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="mk-experts">
          {EXPERTS.map((e, i) => (
            <SpotlightCard key={e.id} e={e} i={i} />
          ))}
        </div>
      </Reveal>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────
// PRICING — the honesty section. Receipt floats against scroll.
// ─────────────────────────────────────────────────────────────────
function Pricing() {
  const reduced = useReduced();
  const receipt = useScrollFx(FX_RECEIPT, reduced);
  return (
    <section className="mk-section" id="pricing">
      <Reveal className="mk-wrap mk-price">
        <div>
          <div className="mk-eyebrow mk-reveal">Pricing</div>
          <h2 className="mk-h2 mk-reveal" style={{ '--i': 1 }}>
            One all-in rate. No surprises.
          </h2>
          <p className="mk-sub mk-reveal" style={{ '--i': 2 }}>
            Every expert sets their own per-minute rate. The number on their profile is the number
            you pay.
          </p>
          <ul className="mk-price-list">
            {PRICE_POINTS.map((p, i) => (
              <li className="mk-reveal" style={{ '--i': i + 3 }} key={p.t}>
                <span className="mk-tick">
                  <I.check size={12} />
                </span>
                <div>
                  <strong>{p.t}</strong>
                  {p.d}
                </div>
              </li>
            ))}
          </ul>
          <div className="mk-price-nos mk-reveal" style={{ '--i': 6 }}>
            {NOS.map((n) => (
              <span className="mk-no" key={n}>
                {n}
              </span>
            ))}
          </div>
        </div>

        <div className="mk-receipt-wrap mk-reveal" style={{ '--i': 2 }}>
          <div className="mk-receipt-glow" />
          <div className="mk-receipt" ref={receipt}>
            <div className="mk-rc-head">
              <span className="mk-rc-kicker">Session receipt</span>
              <span className="mk-rc-paid">Paid</span>
            </div>
            <div className="mk-rc-who">
              <div
                className="mk-avatar"
                style={{ background: avatarGradient('usr_priya'), borderRadius: '50%' }}
              >
                PN
              </div>
              <div>
                <strong>Priya Nair</strong>
                <span>Data Cloud setup review</span>
              </div>
            </div>
            <div className="mk-rc-row">
              <span>Duration</span>
              <span className="mk-mono">23 min</span>
            </div>
            <div className="mk-rc-row">
              <span>Rate</span>
              <span className="mk-mono">A$2.40 / min</span>
            </div>
            <div className="mk-rc-row">
              <span>Service fee</span>
              <span className="mk-mono">Included</span>
            </div>
            <div className="mk-rc-total">
              <span>Total</span>
              <span className="mk-rc-total-val">A$55.20</span>
            </div>
            <div className="mk-rc-foot">Billed to the minute · 14 Aug 2026 · Visa ····4242</div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────
// EXPERT BAND — the one dark moment on the page. No fee language.
// ─────────────────────────────────────────────────────────────────
function ExpertBand() {
  const reduced = useReduced();
  const g1 = useScrollFx(FX_GLOW_A, reduced);
  const g2 = useScrollFx(FX_GLOW_B, reduced);
  return (
    <section className="mk-xband" id="for-experts">
      <div className="mk-xband-glow" ref={g1} aria-hidden="true" />
      <div className="mk-xband-glow mk-xband-glow2" ref={g2} aria-hidden="true" />
      <div className="mk-xband-grid" aria-hidden="true" />
      <Reveal className="mk-wrap mk-xband-inner">
        <div>
          <div className="mk-eyebrow mk-reveal">For experts</div>
          <h2 className="mk-h2 mk-reveal" style={{ '--i': 1 }}>
            Built for the experts, too.
          </h2>
          <p className="mk-sub mk-reveal" style={{ '--i': 2 }}>
            Keep the work you love and lose the admin. Set your rate, open the hours you want, and
            let pre-qualified clients come to you.
          </p>
          <div className="mk-xband-ctas mk-reveal" style={{ '--i': 3 }}>
            <a className="mk-btn mk-btn-lg mk-btn-white" href="#for-experts">
              Apply to join
              <I.arrow size={16} />
            </a>
            <a className="mk-btn mk-btn-lg mk-btn-outline-light" href="#experts">
              How vetting works
            </a>
          </div>
        </div>
        <div className="mk-perks">
          {PERKS.map((p, i) => {
            const Ic = p.icon;
            return (
              <div className="mk-reveal" style={{ '--i': i + 2 }} key={p.t}>
                <div className="mk-perk">
                  <div className="mk-perk-icon">
                    <Ic size={18} />
                  </div>
                  <div>
                    <strong>{p.t}</strong>
                    <span>{p.d}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Reveal>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────
// TESTIMONIALS (placeholder quotes — MJ to source real ones)
// ─────────────────────────────────────────────────────────────────
function Quotes() {
  return (
    <section className="mk-section mk-mist">
      <Reveal className="mk-wrap">
        <div className="mk-head">
          <div>
            <div className="mk-eyebrow mk-reveal">From clients</div>
            <h2 className="mk-h2 mk-reveal" style={{ '--i': 1 }}>
              Small questions, big builds, same place.
            </h2>
          </div>
        </div>
        <div className="mk-quotes">
          {QUOTES.map((t, i) => (
            <div className="mk-reveal" style={{ '--i': i + 2 }} key={t.name}>
              <figure className="mk-quote">
                <div className="mk-stars">
                  <Stars rating={5} size={13} />
                </div>
                <blockquote style={{ margin: 0, flex: 1 }}>
                  <p>“{t.q}”</p>
                </blockquote>
                <figcaption className="mk-quote-who">
                  <div
                    className="mk-avatar"
                    style={{
                      background: avatarGradient(t.name),
                      width: 38,
                      height: 38,
                      fontSize: 12,
                      borderRadius: '50%',
                    }}
                  >
                    {initials(t.name)}
                  </div>
                  <div>
                    <div className="mk-quote-name">{t.name}</div>
                    <div className="mk-quote-role">{t.role}</div>
                  </div>
                </figcaption>
                <div className="mk-quote-ctx">{t.ctx}</div>
              </figure>
            </div>
          ))}
        </div>
      </Reveal>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────
// FINAL CTA + FOOTER
// ─────────────────────────────────────────────────────────────────
function FinalCta() {
  return (
    <section className="mk-final">
      <Reveal className="mk-wrap">
        <div className="mk-final-card mk-reveal">
          <div className="mk-final-grid" aria-hidden="true" />
          <h2>Your next {VERTICAL.name} fix is minutes away.</h2>
          <p>Search vetted experts, book the next open slot, and pay only for the time you use.</p>
          <div className="mk-final-ctas">
            <a className="mk-btn mk-btn-lg mk-btn-white" href="#top">
              Find an expert
              <I.arrow size={16} />
            </a>
            <a className="mk-btn mk-btn-lg mk-btn-outline-light" href="#for-experts">
              Become an expert
            </a>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

function Footer() {
  return (
    <footer className="mk-footer">
      <div className="mk-wrap">
        <div className="mk-footer-grid">
          <div className="mk-footer-brand">
            <a className="mk-logo" href="#top" aria-label="Balo home">
              <span className="mk-logo-mark" />
              Balo
            </a>
            <p>
              Vetted {VERTICAL.name} experts, bookable by the minute. Consultations, projects and
              packages in one place.
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <a
                className="mk-btn mk-btn-ghost"
                style={{ width: 40, height: 40, padding: 0, borderRadius: 10 }}
                href="#top"
                aria-label="Balo on LinkedIn"
              >
                <I.linkedin size={16} />
              </a>
            </div>
          </div>
          {FOOTER.map((col) => (
            <div key={col.h}>
              <h4>{col.h}</h4>
              <ul>
                {col.links.map((l) => (
                  <li key={l}>
                    <a href="#top">{l}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mk-footer-bottom">
          <span>© 2026 Balo Technologies</span>
          <nav aria-label="Legal">
            <a href="#top">Privacy</a>
            <a href="#top">Terms</a>
            <a href="#top">Cookies</a>
          </nav>
        </div>
      </div>
    </footer>
  );
}

// ─────────────────────────────────────────────────────────────────
// ROOT
// ─────────────────────────────────────────────────────────────────
export default function MarketingHome() {
  const [hero, setHero] = useState('light');
  const [motion, setMotion] = useState('full');
  const prefersReduced = usePrefersReduced();
  const reduced = motion === 'reduced' || prefersReduced;
  return (
    <>
      <style>{CSS}</style>
      <ControlStrip
        hero={hero}
        setHero={setHero}
        motion={motion}
        setMotion={setMotion}
        prefersReduced={prefersReduced}
      />
      <MotionCtx.Provider value={reduced}>
        <div className={`mk-page${hero === 'deep' ? ' deep' : ''}${reduced ? ' reduced' : ''}`}>
          <Nav />
          <Hero />
          <Proof />
          <Ways />
          <HowItWorks />
          <Experts />
          <Pricing />
          <ExpertBand />
          <Quotes />
          <FinalCta />
          <Footer />
        </div>
      </MotionCtx.Provider>
    </>
  );
}
