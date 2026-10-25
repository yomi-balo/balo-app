import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * project-proposal-v2.jsx — single-page proposal composer (design reference).
 *
 * Supersedes the tabbed composer in `project-proposal.jsx` (Overview / Milestones /
 * Payment & terms / Attachments). One page, fixed section order, a property bar for the
 * choices that shape everything below it, and a live rail with a jump-to checklist.
 *
 * FIELD MAP (packages/db/src/schema/request-origination.ts) — no new columns:
 *   Property bar   pricing     → proposals.pricing_method ('fixed' | 'tm')
 *                  timeframe   → proposals.timeframe_weeks (proposal-level; milestones carry no duration)
 *                  terms       → proposal_documents kind 'terms', alongside Balo standard terms
 *   Overview                   → proposals.overview (sanitised HTML)
 *   Milestones                 → proposal_milestones: title, description_html, acceptance_criteria
 *                                ("Done when"), value_cents (fixed) | estimated_minutes (tm)
 *   Price and payments (fixed) → proposals.price_cents (expert-typed) + proposal_payment_installments
 *                                (label + whole-percent pct); milestone value_cents optional
 *   Rates and billing (tm)     → proposals.rate_cents, deposit_cents, cadence ('fortnightly' | 'monthly')
 *   Not included               → proposals.exclusions
 *   Attachments                → proposal_documents kind 'ref' | 'terms'
 *   Change-request notes       → proposal_change_requests.section pins each note to its section
 *
 * DECISIONS BAKED IN
 *   1. Fixed price: the expert types ONE project price (fixedPriceCents → price_cents), exactly as
 *      BAL-294 does today. Experts think "this project costs A$15,000", not per deliverable.
 *   1a. Per-milestone amounts are OPTIONAL behind a "Price each milestone" switch (off by default;
 *      on when a loaded draft already has values). When on, every milestone needs an amount and the
 *      amounts must add up to the price; switching it off clears them (Undo toast).
 *   2. T&M: price_cents = Σ estimated_minutes / 60 × rate_cents (the BAL-294 derivation), shown as
 *      an estimate. Hour estimates stay required under T&M.
 *   3. Switching pricing method keeps the typed price, milestone values, and estimated_minutes in
 *      client state, so switching back restores them (Undo toast replaces the BAL-294 confirm
 *      dialog). T&M → Fixed pre-fills a blank price with the last T&M estimate, as today.
 *   4. No proposal title is introduced: the heading is the request title (proposals has no title).
 *   5. The AI draft fills overview + milestone titles, descriptions and "Done when" criteria —
 *      NEVER amounts or hours. It runs as an async job when the draft proposal is created, mirroring
 *      enqueue-project-brief-parse. Pricing stays the expert's call.
 *   6. Fee concealment: every figure is the expert's 100% amount. The preview shows the client's
 *      layout with the expert's figures and says so. No marked-up number renders anywhere.
 *   7. The send CTA is never disabled (blue→violet = conversion surface). When something is
 *      missing it scrolls to the first problem, focuses it, and nudges the checklist.
 *   7a. Terms attach through the property bar (kind 'terms', one supplement, replaced as today);
 *      the Attachments section adds 'ref' documents only. A document's kind never changes after upload.
 *   8. Keyboard: Enter in a milestone title adds the next one; Backspace on an empty title removes
 *      it; ⌘/Ctrl+Enter previews; Esc closes popovers. Files dropped anywhere attach as references.
 *
 * The dashed "Prototype state" bar is reference-only: it switches between a fresh AI draft, a blank
 * start (draft unavailable or dismissed), and a v2 answering a client change request.
 */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap');
.pp, .pp *, .pp *::before, .pp *::after { box-sizing: border-box; }
.pp {
  --ink:#0F172A; --ink2:#334155; --muted:#64748B; --faint:#94A3B8;
  --line:#E2E8F0; --line2:#CBD5E1; --soft:#F8FAFC; --soft2:#F1F5F9;
  --blue:#2563EB; --blue-soft:#EFF4FF; --blue-line:#C7D7FE;
  --violet:#5B4BC4; --violet-soft:#F3F0FF;
  --warn:#B45309; --warn-bg:#FFF7E8; --warn-line:#F8D9A6;
  --ok:#15803D; --ok-bg:#EFFAF2; --ok-line:#BFE3CB;
  --danger:#DC2626;
  --grad:linear-gradient(90deg,#4F7CF0 0%,#9A6BF2 100%);
  font-family:'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  color:var(--ink); background:#fff; min-height:100vh; font-size:15px; line-height:1.55;
  -webkit-font-smoothing:antialiased;
}
:where(.pp button, .pp input, .pp textarea, .pp select) { font-family:inherit; color:inherit; }
.pp :focus-visible { outline:2px solid var(--blue); outline-offset:2px; }

.proto { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:8px 24px; font-size:12.5px; color:var(--muted); background:var(--soft); border-bottom:1px dashed var(--line2); }
.proto button { border:1px solid var(--line); background:#fff; border-radius:999px; padding:3px 10px; font-size:12.5px; color:var(--ink2); cursor:pointer; }
.proto button.on { border-color:var(--ink); color:var(--ink); font-weight:500; }

.top { position:sticky; top:0; z-index:20; height:56px; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:0 24px; background:rgba(255,255,255,.94); backdrop-filter:saturate(1.4) blur(8px); border-bottom:1px solid var(--line); }
.crumbs { display:flex; align-items:center; gap:8px; font-size:14px; color:var(--muted); min-width:0; white-space:nowrap; }
.crumbs b { color:var(--ink); font-weight:500; }
.crumbs .sep { color:var(--line2); }
.save { display:flex; align-items:center; gap:7px; font-size:13px; color:var(--muted); white-space:nowrap; }
.dot { width:6px; height:6px; border-radius:50%; background:var(--faint); }

.layout { max-width:1160px; margin:0 auto; padding:36px 24px 140px; display:grid; grid-template-columns:minmax(0,1fr) 300px; gap:56px; }
.layout.solo { grid-template-columns:minmax(0,1fr); }
.layout.solo .main { max-width:780px; margin:0 auto; width:100%; }
.main { min-width:0; max-width:720px; }
.rail { position:sticky; top:80px; align-self:start; }

.for { display:flex; align-items:center; gap:10px; font-size:14px; color:var(--muted); margin-bottom:6px; }
.for strong { color:var(--ink2); font-weight:500; }
.vchip { font-size:12px; font-weight:500; color:var(--blue); background:var(--blue-soft); border-radius:999px; padding:2px 9px; }
.title { font-size:30px; line-height:1.2; font-weight:600; letter-spacing:-0.02em; margin:0 0 16px; }

.props { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:20px; }
.chipwrap { position:relative; }
.chip { display:inline-flex; align-items:center; gap:7px; height:34px; padding:0 12px; border:1px solid var(--line); border-radius:9px; background:#fff; font-size:14px; color:var(--ink2); cursor:pointer; transition:background .12s,border-color .12s; }
.chip:hover { background:var(--soft); border-color:var(--line2); }
.chip.empty { color:var(--muted); border-style:dashed; }
.chip svg { color:var(--muted); }
.scrim { position:fixed; inset:0; z-index:25; }
.pop { position:absolute; z-index:30; top:calc(100% + 6px); left:0; width:320px; background:#fff; border:1px solid var(--line); border-radius:14px; box-shadow:0 16px 40px rgba(15,23,42,.12),0 2px 6px rgba(15,23,42,.06); padding:6px; }
.opt { display:grid; grid-template-columns:minmax(0,1fr) 18px; gap:10px; width:100%; text-align:left; background:none; border:0; border-radius:10px; padding:10px 12px; cursor:pointer; }
.opt:hover { background:var(--soft); }
.opt b { display:block; font-weight:500; font-size:14px; color:var(--ink); }
.opt small { display:block; font-size:13px; color:var(--muted); line-height:1.45; margin-top:2px; }
.opt svg { color:var(--blue); margin-top:2px; }
.pop-pad { padding:10px 12px 12px; }
.pop-pad p { margin:0 0 12px; font-size:13.5px; color:var(--muted); }
.stepper { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
.stepper input { width:64px; height:38px; text-align:center; border:1px solid var(--line); border-radius:9px; font-size:15px; }
.stepper input:focus { outline:none; border-color:var(--blue); box-shadow:0 0 0 3px rgba(37,99,235,.12); }
.sq { width:38px; height:38px; display:grid; place-items:center; border:1px solid var(--line); border-radius:9px; background:#fff; cursor:pointer; color:var(--ink2); }
.sq:hover { background:var(--soft); }
.muted { color:var(--muted); font-size:14px; }
.pop-file { display:flex; align-items:center; gap:8px; font-size:13.5px; }
.pop-file span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

.brief { border:1px solid var(--line); border-radius:14px; background:var(--soft); padding:14px 16px; }
.brief-top { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
.brief-who { display:flex; align-items:center; gap:7px; font-size:13px; color:var(--muted); margin-bottom:4px; }
.brief-sum { font-size:14.5px; color:var(--ink2); margin:0; }
.brief-body { margin-top:12px; padding-top:12px; border-top:1px solid var(--line); font-size:14px; color:var(--ink2); }
.brief-body p { margin:0 0 10px; }
.facts { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin:12px 0 0; }
.facts dt { font-size:12.5px; color:var(--muted); }
.facts dd { margin:2px 0 0; font-size:14px; font-weight:500; }
.linkbtn { background:none; border:0; padding:0; color:var(--blue); font-size:13.5px; font-weight:500; cursor:pointer; white-space:nowrap; }
.linkbtn:hover { text-decoration:underline; }

.cr-summary { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 14px; border-radius:12px; background:var(--blue-soft); color:var(--ink2); font-size:14px; margin-bottom:16px; }
.cr-summary span { display:flex; align-items:center; gap:8px; }
.cr { display:grid; grid-template-columns:32px minmax(0,1fr); gap:12px; padding:14px 16px; border:1px solid var(--blue-line); background:var(--blue-soft); border-radius:14px; margin-bottom:18px; }
.cr.done { background:#fff; border-color:var(--line); }
.avatar { width:32px; height:32px; border-radius:50%; display:grid; place-items:center; background:#fff; border:1px solid var(--blue-line); font-size:12px; font-weight:600; color:var(--blue); flex-shrink:0; }
.cr-head { font-size:14px; color:var(--ink2); }
.cr-head strong { font-weight:600; color:var(--ink); }
.cr-quote { margin:6px 0 8px; font-size:14.5px; color:var(--ink); }
.cr-ok { display:inline-flex; align-items:center; gap:6px; color:var(--ok); font-size:13.5px; margin:4px 12px 0 0; }

.section { margin-top:44px; }
.sh { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.sh h2 { font-size:18px; font-weight:600; letter-spacing:-0.01em; margin:0; display:flex; align-items:baseline; gap:8px; }
.sh h2 small { font-size:13px; font-weight:400; color:var(--faint); }
.help { margin:4px 0 14px; font-size:14px; color:var(--muted); }
.badge-ai { display:inline-flex; align-items:center; gap:6px; font-size:12.5px; font-weight:500; color:var(--violet); background:var(--violet-soft); border-radius:999px; padding:3px 10px 3px 8px; }
.sh-right { display:flex; align-items:center; gap:12px; }

.editor { border:1px solid var(--line); border-radius:14px; background:#fff; transition:border-color .15s, box-shadow .15s; }
.editor.focus { border-color:var(--blue); box-shadow:0 0 0 4px rgba(37,99,235,.10); }
.tools { display:flex; gap:2px; padding:6px; border-bottom:1px solid var(--line); }
.tool { width:32px; height:30px; display:grid; place-items:center; border:0; background:none; border-radius:7px; color:var(--ink2); cursor:pointer; font-size:13.5px; font-weight:600; }
.tool:hover { background:var(--soft2); }
.tools-hint { margin-left:auto; align-self:center; padding-right:8px; font-size:12.5px; color:var(--faint); }
.rte { min-height:140px; padding:14px 18px; outline:none; font-size:15px; line-height:1.7; }
.rte:empty::before { content:attr(data-placeholder); color:var(--faint); }
.rte p { margin:0 0 12px; } .rte p:last-child { margin-bottom:0; }
.rte h3 { font-size:16px; font-weight:600; margin:14px 0 6px; }
.rte ul { margin:0 0 12px; padding-left:20px; }

.sk-wrap { padding:18px; display:grid; gap:10px; }
.sk-label { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--violet); margin-bottom:4px; }
.sk { height:11px; border-radius:6px; background:linear-gradient(90deg,var(--soft2) 0%,#E6EAF1 50%,var(--soft2) 100%); background-size:200% 100%; animation:shimmer 1.3s linear infinite; }
@keyframes shimmer { from { background-position:200% 0 } to { background-position:-200% 0 } }
.reveal { animation:reveal .45s ease-out both; }
@keyframes reveal { from { opacity:0; transform:translateY(4px) } to { opacity:1; transform:none } }

.ms-list { border:1px solid var(--line); border-radius:14px; overflow:hidden; }
.ms { border-bottom:1px solid var(--line); background:#fff; }
.ms:last-child { border-bottom:0; }
.ms.dragging { opacity:.45; }
.ms-row { display:grid; grid-template-columns:18px 22px minmax(0,1fr) 140px 30px 30px; align-items:center; gap:6px; padding:8px 10px 8px 8px; }
.grip { color:var(--line2); cursor:grab; display:grid; place-items:center; height:28px; }
.ms:hover .grip { color:var(--faint); }
.ms-num { font-size:13px; color:var(--faint); text-align:center; font-variant-numeric:tabular-nums; }
.ms-row.nocol { grid-template-columns:18px 22px minmax(0,1fr) 30px 30px; }
.switch { display:inline-flex; align-items:center; gap:8px; font-size:13.5px; color:var(--ink2); cursor:pointer; background:none; border:0; padding:4px 2px; }
.switch .track { width:32px; height:18px; border-radius:999px; background:var(--line2); position:relative; transition:background .15s; flex-shrink:0; }
.switch .track::after { content:''; position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%; background:#fff; box-shadow:0 1px 2px rgba(15,23,42,.2); transition:transform .15s; }
.switch[aria-checked="true"] .track { background:var(--blue); }
.switch[aria-checked="true"] .track::after { transform:translateX(14px); }
.alloc { display:flex; align-items:center; justify-content:flex-end; gap:10px; flex-wrap:wrap; font-size:13.5px; padding:6px 4px 0; }
.alloc.ok { color:var(--ok); } .alloc.warn { color:var(--warn); }
.price-field { max-width:280px; margin-bottom:22px; }
.price-field .money { height:44px; }
.price-field .money input { font-size:18px; font-weight:600; text-align:left; }
.ms-title { width:100%; border:0; background:transparent; font-size:15px; font-weight:500; padding:7px 8px; border-radius:8px; }
.ms-title:hover { background:var(--soft); }
.ms-title:focus { outline:none; background:var(--soft); box-shadow:inset 0 0 0 1px var(--blue-line); }
.ms-title::placeholder { color:var(--faint); font-weight:400; }
.ms-peek { display:block; width:100%; text-align:left; background:none; border:0; padding:0 50px 10px 62px; margin-top:-4px; font-size:13.5px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; }
.ms-detail { padding:2px 50px 16px 62px; display:grid; gap:12px; }
.ms-detail .fl { font-size:12.5px; font-weight:500; color:var(--muted); display:block; margin-bottom:4px; }
.icon-btn { width:30px; height:30px; display:grid; place-items:center; border:0; background:none; border-radius:8px; color:var(--faint); cursor:pointer; }
.icon-btn:hover { background:var(--soft2); color:var(--ink2); }
.icon-btn.del { opacity:0; }
.ms:hover .icon-btn.del, .inst:hover .icon-btn.del, .docrow:hover .icon-btn.del, .icon-btn.del:focus-visible { opacity:1; }
.icon-btn.del:hover { color:var(--danger); }
.rot { transform:rotate(180deg); }
.money { display:flex; align-items:center; height:36px; border:1px solid var(--line); border-radius:9px; background:#fff; padding:0 10px; gap:4px; transition:border-color .12s, box-shadow .12s; cursor:text; }
.money:focus-within { border-color:var(--blue); box-shadow:0 0 0 3px rgba(37,99,235,.12); }
.money span { font-size:13.5px; color:var(--faint); }
.money input { flex:1; min-width:0; width:100%; border:0; outline:none; background:transparent; text-align:right; font-size:15px; font-variant-numeric:tabular-nums; }
.money input::placeholder { color:var(--line2); }
.money input:focus-visible { outline:none; }
.kindtag { font-size:12.5px; color:var(--muted); background:var(--soft2); border-radius:999px; padding:2px 9px; white-space:nowrap; }
.list-foot { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 4px 0; flex-wrap:wrap; }
.ghost { display:inline-flex; align-items:center; gap:6px; height:34px; padding:0 10px; border:0; background:none; border-radius:8px; color:var(--ink2); font-size:14px; font-weight:500; cursor:pointer; }
.ghost:hover { background:var(--soft2); }
.total { font-size:14px; color:var(--muted); }
.total strong { color:var(--ink); font-weight:600; font-variant-numeric:tabular-nums; }
.suggest { font-size:13px; color:var(--muted); display:flex; align-items:center; gap:8px; }
.suggest svg { color:var(--violet); }

.ta { display:block; width:100%; resize:none; border:1px solid var(--line); border-radius:10px; padding:10px 12px; font-size:14.5px; line-height:1.6; background:#fff; overflow:hidden; }
.ta:focus { outline:none; border-color:var(--blue); box-shadow:0 0 0 3px rgba(37,99,235,.12); }
.ta::placeholder { color:var(--faint); }

.presets { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; }
.preset { height:30px; padding:0 12px; border:1px solid var(--line); border-radius:999px; background:#fff; font-size:13.5px; color:var(--ink2); cursor:pointer; }
.preset:hover { border-color:var(--line2); }
.preset.on { border-color:var(--blue); background:var(--blue-soft); color:var(--blue); font-weight:500; }
.inst-list { border:1px solid var(--line); border-radius:14px; overflow:hidden; }
.inst { display:grid; grid-template-columns:minmax(0,1fr) 92px 110px 30px; align-items:center; gap:8px; padding:8px 10px 8px 10px; border-bottom:1px solid var(--line); background:#fff; }
.inst:last-child { border-bottom:0; }
.inst-label { width:100%; border:0; background:transparent; font-size:15px; padding:7px 8px; border-radius:8px; }
.inst-label:hover { background:var(--soft); }
.inst-label:focus { outline:none; background:var(--soft); box-shadow:inset 0 0 0 1px var(--blue-line); }
.inst-amt { text-align:right; font-size:14px; color:var(--muted); font-variant-numeric:tabular-nums; }
.sum { display:inline-flex; align-items:center; gap:6px; font-size:13.5px; }
.sum.ok { color:var(--ok); } .sum.warn { color:var(--warn); }

.grid2 { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; margin-bottom:16px; }
.field { border-radius:10px; }
.field .fl { display:block; font-size:13.5px; font-weight:500; margin-bottom:6px; }
.field .fh { font-size:12.5px; color:var(--muted); margin-top:6px; }
.seg { display:inline-flex; padding:3px; background:var(--soft2); border-radius:10px; gap:2px; }
.seg button { height:32px; padding:0 14px; border:0; border-radius:8px; background:transparent; font-size:14px; color:var(--muted); cursor:pointer; }
.seg button.on { background:#fff; color:var(--ink); font-weight:500; box-shadow:0 1px 2px rgba(15,23,42,.08); }

.docs { display:grid; gap:8px; margin-bottom:10px; }
.docrow { display:grid; grid-template-columns:20px minmax(0,1fr) auto 30px; align-items:center; gap:10px; padding:8px 8px 8px 12px; border:1px solid var(--line); border-radius:12px; }
.docrow > svg { color:var(--muted); }
.docname { font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.docname span { color:var(--faint); margin-left:8px; font-size:13px; }
.kind { height:30px; border:1px solid var(--line); border-radius:8px; background:#fff; font-size:13px; padding:0 6px; color:var(--ink2); }
.dropzone { display:flex; align-items:center; justify-content:center; gap:8px; padding:18px; border:1.5px dashed var(--line2); border-radius:14px; color:var(--muted); font-size:14px; cursor:pointer; text-align:center; }
.dropzone:hover { background:var(--soft); }
.dropzone u { color:var(--blue); text-decoration:none; font-weight:500; }
.drop-overlay { position:fixed; inset:0; z-index:60; background:rgba(239,244,255,.85); display:grid; place-items:center; pointer-events:none; }
.drop-overlay div { display:flex; align-items:center; gap:10px; padding:16px 22px; border:2px dashed var(--blue); border-radius:16px; background:#fff; color:var(--blue); font-weight:500; }

.card { border:1px solid var(--line); border-radius:18px; padding:20px; background:#fff; }
.r-label { font-size:13px; color:var(--muted); }
.r-total { font-size:30px; font-weight:600; letter-spacing:-0.02em; font-variant-numeric:tabular-nums; margin:2px 0 4px; line-height:1.15; }
.r-total small { font-size:15px; font-weight:500; color:var(--muted); letter-spacing:0; }
.r-sub { font-size:13px; color:var(--muted); margin:0 0 10px; }
.badge-ok { display:inline-flex; align-items:center; gap:5px; font-size:12.5px; font-weight:500; color:var(--ok); background:var(--ok-bg); border:1px solid var(--ok-line); border-radius:999px; padding:2px 9px 2px 7px; }
.r-note { font-size:13px; color:var(--muted); margin:12px 0 16px; line-height:1.5; }
.r-note a { color:var(--blue); font-weight:500; text-decoration:none; }
.r-note a:hover { text-decoration:underline; }
.r-dl { display:grid; gap:9px; padding:16px 0; border-top:1px solid var(--line); margin:0; }
.r-dl div { display:flex; justify-content:space-between; gap:12px; font-size:14px; }
.r-dl dt { color:var(--muted); }
.r-dl dd { margin:0; text-align:right; font-weight:500; }
.cl { border-top:1px solid var(--line); padding-top:14px; margin-bottom:16px; }
.cl-head { display:flex; align-items:center; gap:7px; font-size:14px; font-weight:600; margin-bottom:6px; }
.cl-head.warn { color:var(--warn); } .cl-head.ok { color:var(--ok); } .cl-head.ai { color:var(--violet); font-weight:500; }
.cl-item { display:flex; align-items:center; justify-content:space-between; gap:8px; text-align:left; background:none; border:0; border-radius:8px; padding:7px 8px; margin:0 -8px; width:calc(100% + 16px); font-size:14px; color:var(--ink2); cursor:pointer; }
.cl-item:hover { background:var(--warn-bg); }
.cl-item.soft { color:var(--muted); }
.cl-item.soft:hover { background:var(--soft2); }
.cl-item svg { color:var(--faint); flex-shrink:0; }
.cl.nudge { animation:nudge .4s ease; }
@keyframes nudge { 0%,100% { transform:none } 25% { transform:translateX(-4px) } 75% { transform:translateX(4px) } }
.cta { width:100%; height:48px; border:0; border-radius:12px; background:var(--grad); color:#fff !important; font-size:15px; font-weight:600; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; gap:8px; transition:filter .15s, transform .1s; }
.cta:hover { filter:brightness(1.06); }
.cta:active { transform:scale(.99); }
.cta-sm { width:auto; height:40px; padding:0 18px; font-size:14px; border-radius:10px; }
.r-foot { font-size:12.5px; color:var(--faint); text-align:center; margin:10px 0 0; }
.btn { display:inline-flex; align-items:center; gap:7px; height:40px; padding:0 16px; border:1px solid var(--line); border-radius:10px; background:#fff; font-size:14px; font-weight:500; color:var(--ink); cursor:pointer; }
.btn:hover { background:var(--soft); }

.flash { animation:flash 1.4s ease-out; }
@keyframes flash { 0%,35% { background-color:var(--warn-bg); box-shadow:inset 0 0 0 2px var(--warn-line) } 100% { background-color:#fff; box-shadow:inset 0 0 0 0 transparent } }

.toast { position:fixed; left:50%; bottom:28px; transform:translateX(-50%); z-index:70; display:flex; align-items:center; gap:14px; max-width:calc(100% - 32px); padding:11px 14px 11px 16px; border-radius:12px; background:var(--ink); color:#fff; font-size:14px; box-shadow:0 12px 32px rgba(15,23,42,.24); }
.toast button { background:none; border:0; color:#A9C1FF; font-weight:600; font-size:14px; cursor:pointer; padding:0; white-space:nowrap; }

.mbar { display:none; position:fixed; left:0; right:0; bottom:0; z-index:40; align-items:center; justify-content:space-between; gap:12px; padding:12px 16px calc(12px + env(safe-area-inset-bottom)); background:#fff; border-top:1px solid var(--line); }
.mbar-total { font-size:17px; font-weight:600; font-variant-numeric:tabular-nums; }
.mbar-sub { font-size:12.5px; color:var(--warn); background:none; border:0; padding:0; cursor:pointer; }
.mbar-sub.ok { color:var(--ok); }

.pv-bar { position:sticky; top:68px; z-index:15; display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; padding:12px 16px; margin-bottom:20px; border:1px solid var(--blue-line); background:var(--blue-soft); border-radius:14px; }
.pv-bar strong { display:block; font-size:14px; }
.pv-bar span { font-size:13px; color:var(--muted); }
.pv-actions { display:flex; gap:8px; flex-wrap:wrap; }
.doc { border:1px solid var(--line); border-radius:18px; padding:44px 52px; }
.doc-from { display:flex; align-items:center; gap:10px; font-size:14px; color:var(--muted); margin-bottom:14px; }
.doc h1 { font-size:30px; font-weight:600; letter-spacing:-0.02em; margin:0 0 20px; line-height:1.2; }
.doc-facts { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; padding:16px 0; border-top:1px solid var(--line); border-bottom:1px solid var(--line); margin:0; }
.doc-facts dt { font-size:12.5px; color:var(--muted); }
.doc-facts dd { margin:2px 0 0; font-weight:500; font-variant-numeric:tabular-nums; }
.doc section { margin-top:32px; }
.doc h2 { font-size:17px; font-weight:600; margin:0 0 10px; }
.doc-body { font-size:15px; line-height:1.75; color:var(--ink2); }
.doc-body p { margin:0 0 12px; }
.doc-ms { list-style:none; margin:0; padding:0; display:grid; gap:10px; }
.doc-ms li { padding:14px 16px; border:1px solid var(--line); border-radius:12px; }
.doc-ms-head { display:flex; justify-content:space-between; gap:12px; font-weight:500; }
.doc-ms-head em { font-style:normal; color:var(--faint); font-weight:400; margin-right:10px; font-variant-numeric:tabular-nums; }
.doc-ms-head > span:last-child { font-variant-numeric:tabular-nums; white-space:nowrap; }
.doc-ms p { margin:6px 0 0; font-size:14px; color:var(--muted); }
.doc-ms p.done { display:flex; gap:6px; align-items:flex-start; color:var(--ink2); }
.doc-ms p.done svg { color:var(--ok); margin-top:3px; flex-shrink:0; }
.doc-table { width:100%; border-collapse:collapse; font-size:14.5px; }
.doc-table td { padding:9px 0; border-bottom:1px solid var(--line); }
.doc-table td:last-child { text-align:right; font-variant-numeric:tabular-nums; }
.doc-table td.pct { color:var(--muted); width:70px; text-align:right; padding-right:24px; }
.doc-note { font-size:13.5px; color:var(--muted); margin:10px 0 0; }
.doc-attach { list-style:none; padding:0; margin:0; display:grid; gap:8px; font-size:14.5px; }
.doc-attach li { display:flex; align-items:center; gap:8px; color:var(--ink2); }
.doc-attach small { color:var(--faint); font-size:13px; }

.sent { max-width:560px; margin:56px auto 0; text-align:center; }
.sent-icon { width:64px; height:64px; margin:0 auto 20px; border-radius:50%; display:grid; place-items:center; color:#fff; background:var(--grad); }
.sent h1 { font-size:26px; font-weight:600; letter-spacing:-0.02em; margin:0 0 10px; }
.sent p { color:var(--muted); margin:0 0 24px; }
.sent-actions { display:flex; justify-content:center; gap:10px; flex-wrap:wrap; }
.pop-in { animation:popin .5s cubic-bezier(.2,.9,.3,1.3) both; }
@keyframes popin { from { transform:scale(.6); opacity:0 } to { transform:none; opacity:1 } }

@media (max-width:1020px) {
  .layout { grid-template-columns:minmax(0,1fr); gap:0; }
  .rail { display:none; }
  .mbar { display:flex; }
  .main { max-width:none; }
}
@media (max-width:640px) {
  .proto, .top { padding-left:16px; padding-right:16px; }
  .layout { padding:24px 16px 120px; }
  .title, .doc h1 { font-size:24px; }
  .ms-row { grid-template-columns:18px minmax(0,1fr) 108px 30px; }
  .ms-row.nocol { grid-template-columns:18px minmax(0,1fr) 30px; }
  .price-field { max-width:none; }
  .ms-num, .ms-row .icon-btn.del { display:none; }
  .ms-peek, .ms-detail { padding-left:30px; padding-right:12px; }
  .facts, .grid2, .doc-facts { grid-template-columns:minmax(0,1fr); }
  .inst { grid-template-columns:minmax(0,1fr) 84px 30px; }
  .inst-amt { display:none; }
  .crumbs .hide-sm { display:none; }
  .pop { width:min(320px, calc(100vw - 32px)); }
  .doc { padding:28px 20px; }
  .pv-bar { top:64px; }
}
@media (prefers-reduced-motion: reduce) {
  .sk, .reveal, .flash, .cl.nudge, .pop-in { animation:none !important; }
}
`;

// ── Icons (inline, stroke = currentColor) ─────────────────────────────────

const Svg = ({ size = 16, children, ...rest }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...rest}
  >
    {children}
  </svg>
);

const Icon = {
  Check: (p) => (
    <Svg {...p}>
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  ),
  CheckCircle: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </Svg>
  ),
  ChevronDown: (p) => (
    <Svg {...p}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  ),
  ChevronRight: (p) => (
    <Svg {...p}>
      <path d="m9 18 6-6-6-6" />
    </Svg>
  ),
  Plus: (p) => (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  ),
  Minus: (p) => (
    <Svg {...p}>
      <path d="M5 12h14" />
    </Svg>
  ),
  Trash: (p) => (
    <Svg {...p}>
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5" />
    </Svg>
  ),
  Shield: (p) => (
    <Svg {...p}>
      <path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z" />
      <path d="m9 12 2 2 4-4" />
    </Svg>
  ),
  Sparkles: (p) => (
    <Svg {...p}>
      <path d="M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7-4.7-1.8 4.7-1.8z" />
      <path d="M19 15l.7 1.8 1.8.7-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7z" />
    </Svg>
  ),
  Clock: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Svg>
  ),
  Coins: (p) => (
    <Svg {...p}>
      <circle cx="9" cy="9" r="6" />
      <path d="M15.4 10.4A6 6 0 1 1 10.4 15.4" />
    </Svg>
  ),
  File: (p) => (
    <Svg {...p}>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6M8 13h8M8 17h5" />
    </Svg>
  ),
  Paperclip: (p) => (
    <Svg {...p}>
      <path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7" />
    </Svg>
  ),
  Upload: (p) => (
    <Svg {...p}>
      <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />
    </Svg>
  ),
  Alert: (p) => (
    <Svg {...p}>
      <path d="M12 3 2 20h20L12 3z" />
      <path d="M12 10v4M12 17h.01" />
    </Svg>
  ),
  Message: (p) => (
    <Svg {...p}>
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
    </Svg>
  ),
  Cloud: (p) => (
    <Svg {...p}>
      <path d="M7 18a4.5 4.5 0 0 1-.5-9 6 6 0 0 1 11.6 1.5A3.75 3.75 0 0 1 17.5 18z" />
      <path d="m9.5 13.5 2 2 3.5-3.5" />
    </Svg>
  ),
  Send: (p) => (
    <Svg {...p}>
      <path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" />
    </Svg>
  ),
  List: (p) => (
    <Svg {...p}>
      <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
    </Svg>
  ),
  Eye: (p) => (
    <Svg {...p}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  ),
};

const Grip = () => (
  <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">
    {[3, 8, 13].map((y) =>
      [2.5, 7.5].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.4" fill="currentColor" />)
    )}
  </svg>
);

// ── Fixture content ───────────────────────────────────────────────────────

const BRIEF = {
  title: 'Salesforce CPQ rollout',
  company: 'Acme Industrial',
  client: 'Frank Lee',
  clientFirst: 'Frank',
  clientInitials: 'FL',
  summary: 'CPQ across our three product lines, live before our January price change.',
  body: [
    'Our 12 reps quote from spreadsheets today, and pricing errors are costing us margin. We sell three product lines (pumps, valves, and service contracts), with bundles across the first two.',
    'We need guided quoting in Salesforce, approvals for any discount over 15%, and quote templates our customers will actually read. Our two Salesforce admins should be able to maintain it after you finish.',
  ],
  facts: [
    ['Timing', 'Live before 20 January'],
    ['Team', '12 reps, 2 admins'],
    ['Org', 'Sales Cloud Enterprise'],
  ],
};

const EXPERT = { name: 'Priya Nair', initials: 'PN', rateCents: 16500 };

const DRAFT_OVERVIEW_HTML =
  '<p>I’ll set up Salesforce CPQ across Acme Industrial’s three product lines so your reps quote in Salesforce instead of spreadsheets, and you’re live well before the January price change.</p>' +
  '<p>We’ll start with two weeks of discovery with sales ops and finance to map your catalogue, bundles, and the approval path for discounts over 15%. I’ll build in your sandbox so your team can test real quotes before anything reaches production, then hand over to your two admins with documentation and a working session so they can maintain it with confidence.</p>';

const DRAFT_MILESTONES = [
  {
    title: 'Discovery and solution design',
    description:
      'Workshops with sales ops and finance to map your catalogue, bundles, pricing rules, and discount approvals.',
    acceptance:
      'You’ve signed off a solution design covering the catalogue, price rules, and approval matrix.',
    hours: 24,
    dollars: 4000,
  },
  {
    title: 'Build and configure CPQ',
    description:
      'Products, bundles, price rules, quote templates, and an approval chain for discounts over 15%, built in your sandbox.',
    acceptance: 'Reps can produce a correct quote for all three product lines in the sandbox.',
    hours: 56,
    dollars: 9000,
  },
  {
    title: 'Test, train, and go live',
    description:
      'User acceptance testing with your reps, admin handover, and deployment to production.',
    acceptance: 'CPQ is live in production and your admins have signed off the handover.',
    hours: 16,
    dollars: 2400,
  },
];

// '3070' mirrors seedInstallments() in proposal-composer-state.ts (the default today).
const PRESETS = [
  { key: 'one', label: 'One payment', rows: [['On delivery', 100]] },
  {
    key: '3070',
    label: '30 / 70',
    rows: [
      ['Upfront', 30],
      ['On delivery', 70],
    ],
  },
  {
    key: 'half',
    label: '50 / 50',
    rows: [
      ['Upfront', 50],
      ['On delivery', 50],
    ],
  },
  {
    key: 'thirds',
    label: '30 / 40 / 30',
    rows: [
      ['Upfront', 30],
      ['Midway', 40],
      ['On delivery', 30],
    ],
  },
  { key: 'milestone', label: 'One per milestone', rows: null },
];
const presetRows = (key) => rowsFrom(PRESETS.find((p) => p.key === key).rows);

// ── Helpers ───────────────────────────────────────────────────────────────

let seq = 0;
const nid = () => `n${(seq += 1)}`;
const fmt = (cents) =>
  cents == null ? '—' : `A$${Math.round(cents / 100).toLocaleString('en-AU')}`;
const plural = (n, one, many) => (n === 1 ? one : many);
const fmtSize = (b) =>
  b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
const stripHtml = (html) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const rowsFrom = (rows) => rows.map(([label, pct]) => ({ id: nid(), label, pct }));
const blankMilestone = () => ({
  id: nid(),
  title: '',
  description: '',
  acceptance: '',
  valueCents: null,
  estMinutes: null,
  open: false,
});
const lowerFirst = (t) =>
  t.length > 1 && t[1] === t[1].toLowerCase() ? t[0].toLowerCase() + t.slice(1) : t;
const weeksLabel = (w) => (w ? `About ${w} ${plural(w, 'week', 'weeks')}` : null);

function draftedMilestones(withAmounts) {
  return DRAFT_MILESTONES.map((m) => ({
    id: nid(),
    title: m.title,
    description: m.description,
    acceptance: m.acceptance,
    valueCents: withAmounts ? m.dollars * 100 : null,
    estMinutes: m.hours * 60,
    open: false,
  }));
}

/** One installment per milestone: proportional to milestone amounts when every milestone is
 *  priced, otherwise an even split. */
function perMilestoneRows(ms, priced) {
  if (!ms.length) return rowsFrom([['On delivery', 100]]);
  const total =
    priced && ms.every((m) => m.valueCents) ? ms.reduce((s, m) => s + m.valueCents, 0) : 0;
  const rows = ms.map((m, i) => ({
    id: nid(),
    label: m.title || `Milestone ${i + 1}`,
    pct: total ? Math.round(((m.valueCents || 0) / total) * 100) : Math.floor(100 / ms.length),
  }));
  rows[rows.length - 1].pct += 100 - rows.reduce((s, r) => s + r.pct, 0);
  return rows;
}

// ── Small inputs ──────────────────────────────────────────────────────────

/** Whole-number field (dollars, hours, percent). Formats on blur, raw digits while focused. */
function NumField({ id, value, onChange, prefix, suffix, placeholder = '0', ariaLabel }) {
  const [focused, setFocused] = useState(false);
  const [raw, setRaw] = useState('');
  const shown = focused ? raw : value == null ? '' : value.toLocaleString('en-AU');
  return (
    <label className="money">
      {prefix && <span>{prefix}</span>}
      <input
        id={id}
        inputMode="numeric"
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={shown}
        onFocus={() => {
          setRaw(value == null ? '' : String(value));
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          const d = e.target.value.replace(/[^0-9]/g, '').slice(0, 7);
          setRaw(d);
          onChange(d === '' ? null : parseInt(d, 10));
        }}
      />
      {suffix && <span>{suffix}</span>}
    </label>
  );
}

function AutoTextarea({ value, onChange, className = 'ta', rows = 2, ...rest }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={className}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
    />
  );
}

/** Uncontrolled rich text: seeded by `seed.key`, reports (html, text) on input. */
function RichText({ id, seed, onChange, placeholder }) {
  const ref = useRef(null);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = seed.html;
  }, [seed.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const emit = () => {
    const el = ref.current;
    if (!el) return;
    const text = el.innerText.trim();
    if (!text) el.innerHTML = '';
    onChange(el.innerHTML, text);
  };
  const cmd = (name, arg) => {
    document.execCommand(name, false, arg);
    ref.current?.focus();
    emit();
  };
  const tool = (label, onPress, child, style) => (
    <button
      type="button"
      className="tool"
      aria-label={label}
      title={label}
      style={style}
      onMouseDown={(e) => {
        e.preventDefault();
        onPress();
      }}
    >
      {child}
    </button>
  );
  return (
    <div className={`editor ${focused ? 'focus' : ''}`}>
      <div className="tools" role="toolbar" aria-label="Formatting">
        {tool('Bold', () => cmd('bold'), 'B')}
        {tool('Italic', () => cmd('italic'), 'I', { fontStyle: 'italic', fontWeight: 500 })}
        {tool('Heading', () => cmd('formatBlock', '<h3>'), 'H')}
        {tool('Bulleted list', () => cmd('insertUnorderedList'), <Icon.List size={15} />)}
        <span className="tools-hint">Select text to format</span>
      </div>
      <div
        id={id}
        ref={ref}
        className="rte"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Overview"
        data-placeholder={placeholder}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onInput={emit}
      />
    </div>
  );
}

function SectionHead({ title, optional, help, right }) {
  return (
    <>
      <div className="sh">
        <h2>
          {title}
          {optional && <small>Optional</small>}
        </h2>
        {right && <div className="sh-right">{right}</div>}
      </div>
      {help && <p className="help">{help}</p>}
    </>
  );
}

function Field({ label, help, children }) {
  return (
    <div className="field" data-flash="">
      <span className="fl">{label}</span>
      {children}
      {help && <div className="fh">{help}</div>}
    </div>
  );
}

function ChangeNote({ cr, onToggle }) {
  return (
    <div id="cr-note" className={`cr ${cr.addressed ? 'done' : ''}`} data-flash="">
      <span className="avatar">{BRIEF.clientInitials}</span>
      <div>
        <div className="cr-head">
          <strong>{BRIEF.client}</strong> asked for a change to the payment schedule
        </div>
        {!cr.addressed && <p className="cr-quote">“{cr.note}”</p>}
        {cr.addressed && (
          <span className="cr-ok">
            <Icon.CheckCircle size={14} /> Marked as addressed
          </span>
        )}
        <button className="linkbtn" onClick={onToggle}>
          {cr.addressed ? 'Show note' : 'Mark as addressed'}
        </button>
      </div>
    </div>
  );
}

// ── Preview (client layout, expert figures) ───────────────────────────────

function Preview({ s, onBack, onSend }) {
  const fixed = s.pricing === 'fixed';
  const hours = (m) => Math.round((m.estMinutes || 0) / 60);
  return (
    <div>
      <div className="pv-bar">
        <div>
          <strong>Previewing as {BRIEF.company}</strong>
          <span>
            Amounts are what you receive. {BRIEF.company} sees them with Balo’s service margin
            added.
          </span>
        </div>
        <div className="pv-actions">
          <button className="btn" onClick={onBack}>
            Back to editing
          </button>
          <button className="cta cta-sm" onClick={onSend}>
            <Icon.Send size={15} />
            {s.changeReq ? 'Resend' : 'Send'} to {BRIEF.company}
          </button>
        </div>
      </div>

      <article className="doc">
        <div className="doc-from">
          <span className="avatar">{EXPERT.initials}</span>
          Proposal from {EXPERT.name}
          {s.changeReq ? ', version 2' : ''}
        </div>
        <h1>{BRIEF.title}</h1>
        <dl className="doc-facts">
          <div>
            <dt>Pricing</dt>
            <dd>{fixed ? 'Fixed price' : 'Time and materials'}</dd>
          </div>
          <div>
            <dt>Timeframe</dt>
            <dd>{weeksLabel(s.timeframe) || 'To be agreed'}</dd>
          </div>
          <div>
            <dt>{fixed ? 'Total' : 'Hourly rate'}</dt>
            <dd>{fixed ? fmt(s.fixedTotal) : `${fmt(s.rateCents)}/hr`}</dd>
          </div>
        </dl>

        <section>
          <h2>Overview</h2>
          <div className="doc-body" dangerouslySetInnerHTML={{ __html: s.overviewHtml }} />
        </section>

        <section>
          <h2>Milestones</h2>
          <ol className="doc-ms">
            {s.milestones.map((m, i) => (
              <li key={m.id}>
                <div className="doc-ms-head">
                  <span>
                    <em>{i + 1}</em>
                    {m.title}
                  </span>
                  {fixed ? (
                    m.valueCents ? (
                      <span>{fmt(m.valueCents)}</span>
                    ) : null
                  ) : (
                    <span>About {hours(m)} h</span>
                  )}
                </div>
                {m.description && <p>{m.description}</p>}
                {m.acceptance && (
                  <p className="done">
                    <Icon.Check size={14} />
                    <span>Done when {lowerFirst(m.acceptance)}</span>
                  </p>
                )}
              </li>
            ))}
          </ol>
        </section>

        {fixed ? (
          <section>
            <h2>Price and payments</h2>
            <table className="doc-table">
              <tbody>
                {s.installments.map((r) => (
                  <tr key={r.id}>
                    <td>{r.label || 'Payment'}</td>
                    <td className="pct">{r.pct || 0}%</td>
                    <td>{fmt(Math.round((s.fixedTotal * (r.pct || 0)) / 100))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : (
          <section>
            <h2>Rates and billing</h2>
            <table className="doc-table">
              <tbody>
                <tr>
                  <td>Hourly rate</td>
                  <td>{fmt(s.rateCents)}/hr</td>
                </tr>
                <tr>
                  <td>Deposit</td>
                  <td>{fmt(s.depositCents)}</td>
                </tr>
                <tr>
                  <td>Invoiced</td>
                  <td>{s.cadence === 'monthly' ? 'Monthly' : 'Fortnightly'}</td>
                </tr>
                <tr>
                  <td>Estimate</td>
                  <td>{fmt(s.tmEstimate)}</td>
                </tr>
              </tbody>
            </table>
            <p className="doc-note">
              Milestones are a guide, not a cap. You’re billed for time worked.
            </p>
          </section>
        )}

        {s.exclusions.trim() && (
          <section>
            <h2>Not included</h2>
            <div className="doc-body">
              <p>{s.exclusions}</p>
            </div>
          </section>
        )}

        {s.docs.length > 0 && (
          <section>
            <h2>Attachments</h2>
            <ul className="doc-attach">
              {s.docs.map((d) => (
                <li key={d.id}>
                  <Icon.File size={15} />
                  {d.name}
                  <small>{d.kind === 'terms' ? 'Terms' : fmtSize(d.size)}</small>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h2>Terms</h2>
          <div className="doc-body">
            <p>
              Balo standard terms apply
              {s.docs.some((d) => d.kind === 'terms')
                ? `, with ${EXPERT.name}’s own terms attached alongside them.`
                : '.'}
            </p>
          </div>
        </section>
      </article>
    </div>
  );
}

// ── Composer ──────────────────────────────────────────────────────────────

export default function ProjectProposalV2() {
  const [scenario, setScenario] = useState('draft');
  const [drafting, setDrafting] = useState(true);
  const [overviewSeed, setOverviewSeed] = useState({ html: '', key: 0 });
  const [overviewHtml, setOverviewHtml] = useState('');
  const [overviewText, setOverviewText] = useState('');
  const [overviewDrafted, setOverviewDrafted] = useState(false);
  const [milestones, setMilestones] = useState([]);
  const [msSuggested, setMsSuggested] = useState(false);
  const [pricing, setPricing] = useState('fixed');
  const [timeframe, setTimeframe] = useState(6);
  const [priceCents, setPriceCents] = useState(null);
  const [msPricing, setMsPricing] = useState(false);
  const [installments, setInstallments] = useState(() => presetRows('3070'));
  const [presetKey, setPresetKey] = useState('3070');
  const [rateCents, setRateCents] = useState(EXPERT.rateCents);
  const [depositCents, setDepositCents] = useState(null);
  const [cadence, setCadence] = useState('monthly');
  const [exclusions, setExclusions] = useState('');
  const [docs, setDocs] = useState([]);
  const [briefOpen, setBriefOpen] = useState(false);
  const [pop, setPop] = useState(null);
  const [mode, setMode] = useState('edit');
  const [toast, setToast] = useState(null);
  const [saveState, setSaveState] = useState('saved');
  const [changeReq, setChangeReq] = useState(null);
  const [nudge, setNudge] = useState(0);
  const [dropActive, setDropActive] = useState(false);
  const [focusId, setFocusId] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [armed, setArmed] = useState(null);
  const fileRef = useRef(null);
  const termsRef = useRef(null);

  const reduceMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // ── Scenarios (prototype only) ──
  const seedOverview = (html) => {
    setOverviewSeed((s) => ({ html, key: s.key + 1 }));
    setOverviewHtml(html);
    setOverviewText(stripHtml(html));
  };

  const loadScenario = (name) => {
    setScenario(name);
    setMode('edit');
    setPop(null);
    setToast(null);
    setBriefOpen(false);
    setPricing('fixed');
    setPriceCents(null);
    setMsPricing(false);
    setRateCents(EXPERT.rateCents);
    setDepositCents(null);
    setCadence('monthly');
    setNudge(0);
    if (name === 'blank') {
      setDrafting(false);
      seedOverview('');
      setOverviewDrafted(false);
      setMilestones([blankMilestone()]);
      setMsSuggested(false);
      setTimeframe(null);
      setInstallments(presetRows('3070'));
      setPresetKey('3070');
      setExclusions('');
      setDocs([]);
      setChangeReq(null);
    } else if (name === 'changes') {
      setDrafting(false);
      seedOverview(DRAFT_OVERVIEW_HTML);
      setOverviewDrafted(false);
      setMilestones(draftedMilestones(true));
      setMsSuggested(false);
      setPriceCents(1540000);
      setMsPricing(true);
      setTimeframe(6);
      setInstallments(presetRows('half'));
      setPresetKey('half');
      setExclusions(
        'Migrating historical quotes from your spreadsheets, and changes to your ERP integration.'
      );
      setDocs([{ id: nid(), name: 'Acme quote template examples.pdf', size: 482000, kind: 'ref' }]);
      setChangeReq({
        note: 'Could we split this into three payments instead of two? Our finance team would rather not pay half upfront.',
        addressed: false,
      });
    } else {
      seedOverview('');
      setOverviewDrafted(false);
      setMilestones([]);
      setMsSuggested(false);
      setTimeframe(6);
      setInstallments(presetRows('3070'));
      setPresetKey('3070');
      setExclusions('');
      setDocs([]);
      setChangeReq(null);
      setDrafting(true);
    }
  };

  // AI draft lands (simulated async job).
  useEffect(() => {
    if (!drafting) return undefined;
    const t = setTimeout(() => {
      seedOverview(DRAFT_OVERVIEW_HTML);
      setOverviewDrafted(true);
      setMilestones(draftedMilestones(false));
      setMsSuggested(true);
      setDrafting(false);
    }, 1700);
    return () => clearTimeout(t);
  }, [drafting]);

  // ── Derived ──
  const fixed = pricing === 'fixed';
  const fixedTotal = priceCents || 0;
  const allocated = milestones.reduce((s, m) => s + (m.valueCents || 0), 0);
  const totalMinutes = milestones.reduce((s, m) => s + (m.estMinutes || 0), 0);
  const totalHours = Math.round(totalMinutes / 60);
  const tmEstimate = rateCents ? Math.round((totalMinutes / 60) * rateCents) : 0;
  const instSum = installments.reduce((s, r) => s + (Number(r.pct) || 0), 0);
  const termsDoc = docs.find((d) => d.kind === 'terms');

  const issues = [];
  if (!drafting) {
    if (!overviewText)
      issues.push({ id: 'ov', label: 'Add an overview', target: 'overview-editor' });
    if (!milestones.length)
      issues.push({ id: 'none', label: 'Add at least one milestone', target: 'add-milestone' });
    milestones.forEach((m, i) => {
      if (!m.title.trim())
        issues.push({
          id: `t${m.id}`,
          label: `Milestone ${i + 1} needs a title`,
          target: `m-title-${m.id}`,
        });
    });
    if (fixed) {
      if (!priceCents)
        issues.push({ id: 'price', label: 'Set your project price', target: 'fixed-price' });
      if (msPricing) {
        const missing = milestones.filter((m) => !m.valueCents);
        if (missing.length) {
          const first = milestones.indexOf(missing[0]);
          issues.push({
            id: 'amt',
            label:
              missing.length === 1
                ? `Set an amount for milestone ${first + 1}`
                : `Set amounts for ${missing.length} milestones`,
            target: `m-amount-${missing[0].id}`,
          });
        } else if (priceCents && allocated !== priceCents) {
          issues.push({
            id: 'alloc',
            label: `Milestones add up to ${fmt(allocated)}, not ${fmt(priceCents)}`,
            target: `m-amount-${milestones[0].id}`,
          });
        }
      }
      if (!installments.length)
        issues.push({
          id: 'inst0',
          label: 'Add a payment to the schedule',
          target: 'add-installment',
        });
      else if (instSum !== 100)
        issues.push({
          id: 'inst',
          label: `Payments add up to ${instSum}%, not 100%`,
          target: `inst-pct-${installments[0].id}`,
        });
    } else {
      if (!rateCents) issues.push({ id: 'rate', label: 'Set your hourly rate', target: 'tm-rate' });
      if (depositCents == null)
        issues.push({ id: 'dep', label: 'Set a deposit (it can be A$0)', target: 'tm-deposit' });
      const missing = milestones.filter((m) => !m.estMinutes);
      if (missing.length) {
        issues.push({
          id: 'hrs',
          label:
            missing.length === 1
              ? `Add an hour estimate for milestone ${milestones.indexOf(missing[0]) + 1}`
              : `Add hour estimates for ${missing.length} milestones`,
          target: `m-hours-${missing[0].id}`,
        });
      }
    }
  }
  const soft =
    changeReq && !changeReq.addressed
      ? [
          {
            id: 'cr',
            label: `${BRIEF.clientFirst}’s note on payments isn’t marked as addressed`,
            target: 'cr-note',
          },
        ]
      : [];

  // ── Autosave indicator ──
  const snapshot = JSON.stringify([
    overviewText,
    milestones,
    pricing,
    priceCents,
    msPricing,
    timeframe,
    installments,
    rateCents,
    depositCents,
    cadence,
    exclusions,
    docs.length,
  ]);
  const firstSave = useRef(true);
  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false;
      return undefined;
    }
    if (drafting) return undefined;
    setSaveState('saving');
    const t = setTimeout(() => setSaveState('saved'), 700);
    return () => clearTimeout(t);
  }, [snapshot]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep "one per milestone" installments in step with milestone amounts.
  const msKey = milestones.map((m) => `${m.id}:${m.valueCents}:${m.title}`).join('|');
  useEffect(() => {
    if (presetKey === 'milestone') setInstallments(perMilestoneRows(milestones, msPricing));
  }, [msKey, presetKey, msPricing]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), toast.undo ? 6000 : 3000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!focusId) return;
    document.getElementById(`m-title-${focusId}`)?.focus();
    setFocusId(null);
  }, [focusId]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [mode]);

  // ── Navigation ──
  const jumpTo = useCallback(
    (id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      const box = el.closest('[data-flash]') || el;
      box.classList.remove('flash');
      void box.offsetWidth; // restart the animation
      box.classList.add('flash');
      setTimeout(() => el.focus?.({ preventScroll: true }), reduceMotion ? 0 : 380);
    },
    [reduceMotion]
  );

  const goPreview = () => {
    if (issues.length) {
      jumpTo(issues[0].target);
      setNudge((n) => n + 1);
      return;
    }
    setPop(null);
    setMode('preview');
  };
  const goPreviewRef = useRef(goPreview);
  goPreviewRef.current = goPreview;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') setPop(null);
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && mode === 'edit') {
        e.preventDefault();
        goPreviewRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode]);

  // ── Files: drop anywhere ──
  const addFiles = useCallback((files, kind = 'ref') => {
    const list = Array.from(files || []);
    if (!list.length) return;
    setDocs((d) => [...d, ...list.map((f) => ({ id: nid(), name: f.name, size: f.size, kind }))]);
    setToast({
      msg:
        kind === 'terms'
          ? 'Your terms are attached'
          : `${list.length} ${plural(list.length, 'file', 'files')} attached`,
    });
  }, []);

  useEffect(() => {
    let depth = 0;
    const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
    const enter = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      setDropActive(true);
    };
    const over = (e) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const leave = (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDropActive(false);
    };
    const drop = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDropActive(false);
      addFiles(e.dataTransfer.files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [addFiles]);

  // ── Mutations ──
  const switchPricing = (next) => {
    setPop(null);
    if (next === pricing) return;
    const prev = pricing;
    setPricing(next);
    // T&M → Fixed pre-fills a blank price with the last T&M estimate (as BAL-294 does today).
    if (next === 'fixed' && priceCents == null && tmEstimate) setPriceCents(tmEstimate);
    setToast({
      msg:
        next === 'tm'
          ? 'Switched to time and materials. Your fixed amounts come back if you switch again.'
          : 'Switched to fixed price. Your hour estimates come back if you switch again.',
      undo: () => setPricing(prev),
    });
  };

  const toggleMsPricing = () => {
    if (!msPricing) {
      setMsPricing(true);
      return;
    }
    const before = milestones.map((m) => ({ id: m.id, valueCents: m.valueCents }));
    const hadValues = before.some((m) => m.valueCents);
    setMsPricing(false);
    setMilestones((ms) => ms.map((m) => ({ ...m, valueCents: null })));
    if (hadValues) {
      setToast({
        msg: 'Milestone amounts removed. Your project price stays the same.',
        undo: () => {
          setMsPricing(true);
          setMilestones((ms) =>
            ms.map((m) => ({
              ...m,
              valueCents: before.find((b) => b.id === m.id)?.valueCents ?? null,
            }))
          );
        },
      });
    }
  };

  const updateM = (id, patch, descriptive = false) => {
    setMilestones((ms) => ms.map((m) => (m.id === id ? { ...m, ...patch } : m)));
    if (descriptive) setMsSuggested(false);
  };
  const addMilestone = (at) => {
    const m = blankMilestone();
    setMilestones((ms) => {
      const c = [...ms];
      c.splice(at, 0, m);
      return c;
    });
    setMsSuggested(false);
    setFocusId(m.id);
  };
  const removeMilestone = (id, i, focusPrev) => {
    const prev = milestones[i - 1];
    setMilestones((ms) => ms.filter((m) => m.id !== id));
    setMsSuggested(false);
    if (focusPrev && prev) setFocusId(prev.id);
  };
  const onDragOverRow = (e, overId) => {
    if (!dragId) return;
    e.preventDefault();
    if (dragId === overId) return;
    setMilestones((ms) => {
      const from = ms.findIndex((m) => m.id === dragId);
      const to = ms.findIndex((m) => m.id === overId);
      if (from < 0 || to < 0) return ms;
      const c = [...ms];
      const [x] = c.splice(from, 1);
      c.splice(to, 0, x);
      return c;
    });
  };

  const applyPreset = (key) => {
    setPresetKey(key);
    setInstallments(
      key === 'milestone' ? perMilestoneRows(milestones, msPricing) : presetRows(key)
    );
  };
  const updateInst = (id, patch) => {
    setPresetKey(null);
    setInstallments((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };
  const addInst = () => {
    const r = { id: nid(), label: '', pct: Math.max(0, 100 - instSum) };
    setPresetKey(null);
    setInstallments((rs) => [...rs, r]);
    setTimeout(() => document.getElementById(`inst-label-${r.id}`)?.focus(), 0);
  };
  const removeInst = (id) => {
    setPresetKey(null);
    setInstallments((rs) => rs.filter((r) => r.id !== id));
  };

  // ── Rail values ──
  const ctaLabel = changeReq ? 'Preview and resend' : 'Preview and send';
  const paymentsSummary = fixed
    ? installments.length
      ? installments.map((r) => `${r.pct || 0}%`).join(' / ')
      : 'Not set'
    : `${cadence === 'monthly' ? 'Monthly' : 'Fortnightly'} invoices`;
  const totalNode = fixed ? (
    priceCents ? (
      fmt(priceCents)
    ) : (
      '—'
    )
  ) : (
    <>
      {fmt(rateCents)}
      <small>/hr</small>
    </>
  );
  const totalSub = fixed
    ? priceCents
      ? `Paid in ${installments.length} ${plural(installments.length, 'payment', 'payments')}`
      : 'Set your project price'
    : totalMinutes
      ? `About ${totalHours} hours, estimated ${fmt(tmEstimate)}`
      : 'Add hour estimates to see an estimate';

  const state = {
    pricing,
    timeframe,
    fixedTotal,
    rateCents,
    depositCents,
    cadence,
    tmEstimate,
    overviewHtml,
    milestones,
    installments,
    exclusions,
    docs,
    changeReq,
  };

  // ── Render ──
  return (
    <div className="pp">
      <style>{CSS}</style>

      <div className="proto">
        <span>Prototype state</span>
        {[
          ['draft', 'Fresh AI draft'],
          ['blank', 'Blank start'],
          ['changes', 'Changes requested (v2)'],
        ].map(([k, l]) => (
          <button key={k} className={scenario === k ? 'on' : ''} onClick={() => loadScenario(k)}>
            {l}
          </button>
        ))}
      </div>

      <header className="top">
        <nav className="crumbs" aria-label="Breadcrumb">
          <span className="hide-sm">Projects</span>
          <span className="sep hide-sm">/</span>
          <span>{BRIEF.title}</span>
          <span className="sep">/</span>
          <b>Proposal</b>
        </nav>
        <div className="save" aria-live="polite">
          {mode === 'sent' ? (
            <>
              <Icon.CheckCircle size={15} /> Sent
            </>
          ) : changeReq ? (
            <>Not saved until you resend</>
          ) : saveState === 'saving' ? (
            <>
              <span className="dot" /> Saving…
            </>
          ) : (
            <>
              <Icon.Cloud size={16} /> Saved as draft
            </>
          )}
        </div>
      </header>

      <div className={`layout ${mode === 'edit' ? '' : 'solo'}`}>
        <main className="main">
          {mode === 'sent' && (
            <div className="sent">
              <div className="sent-icon pop-in">
                <Icon.Check size={30} />
              </div>
              <h1>
                {changeReq
                  ? 'Version 2 is with Acme Industrial'
                  : 'Nice work. Your proposal is with Acme Industrial'}
              </h1>
              <p>
                {BRIEF.client} @{BRIEF.company} has an email and a notification in Balo. If they’d
                like changes, their notes will appear right beside the section they’re about, so you
                can update it and resend.
              </p>
              <div className="sent-actions">
                <button className="btn" onClick={() => setMode('preview')}>
                  <Icon.Eye size={15} /> View proposal
                </button>
                <button className="btn" onClick={() => loadScenario(scenario)}>
                  Back to project
                </button>
              </div>
            </div>
          )}

          {mode === 'preview' && (
            <Preview s={state} onBack={() => setMode('edit')} onSend={() => setMode('sent')} />
          )}

          {mode === 'edit' && (
            <>
              <div className="for">
                Proposal for <strong>{BRIEF.company}</strong>
                {changeReq && <span className="vchip">Version 2</span>}
              </div>
              <h1 className="title">{BRIEF.title}</h1>

              {/* Property bar: the choices that shape everything below */}
              <div className="props">
                <div className="chipwrap">
                  <button
                    className="chip"
                    aria-haspopup="dialog"
                    aria-expanded={pop === 'pricing'}
                    onClick={() => setPop(pop === 'pricing' ? null : 'pricing')}
                  >
                    <Icon.Coins size={15} />
                    {fixed ? 'Fixed price' : 'Time and materials'}
                    <Icon.ChevronDown size={14} />
                  </button>
                  {pop === 'pricing' && (
                    <>
                      <div className="scrim" onClick={() => setPop(null)} />
                      <div className="pop" role="dialog" aria-label="Pricing method">
                        {[
                          [
                            'fixed',
                            'Fixed price',
                            'One agreed price, paid in installments across the project.',
                          ],
                          [
                            'tm',
                            'Time and materials',
                            'An hourly rate plus a deposit. Milestones are a guide, not a cap.',
                          ],
                        ].map(([k, t, d]) => (
                          <button key={k} className="opt" onClick={() => switchPricing(k)}>
                            <div>
                              <b>{t}</b>
                              <small>{d}</small>
                            </div>
                            {pricing === k ? <Icon.Check size={16} /> : <span />}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                <div className="chipwrap">
                  <button
                    className={`chip ${timeframe ? '' : 'empty'}`}
                    aria-haspopup="dialog"
                    aria-expanded={pop === 'time'}
                    onClick={() => setPop(pop === 'time' ? null : 'time')}
                  >
                    <Icon.Clock size={15} />
                    {weeksLabel(timeframe) || 'Add timeframe'}
                  </button>
                  {pop === 'time' && (
                    <>
                      <div className="scrim" onClick={() => setPop(null)} />
                      <div className="pop" role="dialog" aria-label="Timeframe">
                        <div className="pop-pad">
                          <p>Roughly how long the work will take. A duration, not a date.</p>
                          <div className="stepper">
                            <button
                              className="sq"
                              aria-label="Fewer weeks"
                              onClick={() => setTimeframe((t) => Math.max(1, (t || 1) - 1))}
                            >
                              <Icon.Minus size={15} />
                            </button>
                            <input
                              aria-label="Weeks"
                              inputMode="numeric"
                              value={timeframe ?? ''}
                              onChange={(e) => {
                                const d = e.target.value.replace(/[^0-9]/g, '').slice(0, 3);
                                setTimeframe(d === '' ? null : Math.max(1, parseInt(d, 10)));
                              }}
                            />
                            <button
                              className="sq"
                              aria-label="More weeks"
                              onClick={() => setTimeframe((t) => (t || 0) + 1)}
                            >
                              <Icon.Plus size={15} />
                            </button>
                            <span className="muted">weeks</span>
                          </div>
                          {timeframe != null && (
                            <button
                              className="linkbtn"
                              onClick={() => {
                                setTimeframe(null);
                                setPop(null);
                              }}
                            >
                              Remove timeframe
                            </button>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>

                <div className="chipwrap">
                  <button
                    className="chip"
                    aria-haspopup="dialog"
                    aria-expanded={pop === 'terms'}
                    onClick={() => setPop(pop === 'terms' ? null : 'terms')}
                  >
                    <Icon.File size={15} />
                    {termsDoc ? 'Balo standard and your terms' : 'Balo standard terms'}
                  </button>
                  {pop === 'terms' && (
                    <>
                      <div className="scrim" onClick={() => setPop(null)} />
                      <div className="pop" role="dialog" aria-label="Terms">
                        <div className="pop-pad">
                          <p>
                            Balo standard terms apply to every proposal. You can attach your own
                            terms to sit alongside them.
                          </p>
                          {termsDoc ? (
                            <div className="pop-file">
                              <Icon.File size={15} />
                              <span>{termsDoc.name}</span>
                              <button
                                className="linkbtn"
                                onClick={() =>
                                  setDocs((d) => d.filter((x) => x.id !== termsDoc.id))
                                }
                              >
                                Remove
                              </button>
                            </div>
                          ) : (
                            <button
                              className="btn"
                              onClick={() => {
                                setPop(null);
                                termsRef.current?.click();
                              }}
                            >
                              <Icon.Upload size={15} /> Attach your terms
                            </button>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                  <input
                    ref={termsRef}
                    type="file"
                    accept=".pdf,.doc,.docx"
                    hidden
                    onChange={(e) => {
                      addFiles(e.target.files, 'terms');
                      e.target.value = '';
                    }}
                  />
                </div>
              </div>

              {changeReq && (
                <div className="cr-summary">
                  <span>
                    <Icon.Message size={15} /> {BRIEF.client} @{BRIEF.company} asked for one change.
                  </span>
                  <button className="linkbtn" onClick={() => jumpTo('cr-note')}>
                    Go to note
                  </button>
                </div>
              )}

              {/* The brief stays one click away while writing */}
              <div className="brief">
                <div className="brief-top">
                  <div>
                    <div className="brief-who">
                      <Icon.Message size={14} /> {BRIEF.clientFirst}’s request
                    </div>
                    <p className="brief-sum">{BRIEF.summary}</p>
                  </div>
                  <button
                    className="linkbtn"
                    aria-expanded={briefOpen}
                    onClick={() => setBriefOpen((o) => !o)}
                  >
                    {briefOpen ? 'Hide brief' : 'Show brief'}
                  </button>
                </div>
                {briefOpen && (
                  <div className="brief-body">
                    {BRIEF.body.map((p) => (
                      <p key={p.slice(0, 16)}>{p}</p>
                    ))}
                    <dl className="facts">
                      {BRIEF.facts.map(([k, v]) => (
                        <div key={k}>
                          <dt>{k}</dt>
                          <dd>{v}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}
              </div>

              {/* Overview */}
              <section className="section" id="sec-overview">
                <SectionHead
                  title="Overview"
                  help={`What you’ll do, how you’ll approach it, and what ${BRIEF.company} can expect.`}
                  right={
                    overviewDrafted && (
                      <>
                        <span className="badge-ai">
                          <Icon.Sparkles size={13} /> Drafted from {BRIEF.clientFirst}’s request
                        </span>
                        <button
                          className="linkbtn"
                          onClick={() => {
                            seedOverview('');
                            setOverviewDrafted(false);
                          }}
                        >
                          Clear
                        </button>
                      </>
                    )
                  }
                />
                {drafting ? (
                  <div className="editor">
                    <div className="sk-wrap">
                      <div className="sk-label">
                        <Icon.Sparkles size={14} /> Drafting from {BRIEF.clientFirst}’s request…
                      </div>
                      {[100, 96, 88, 100, 70].map((w, i) => (
                        <div key={i} className="sk" style={{ width: `${w}%` }} />
                      ))}
                    </div>
                  </div>
                ) : (
                  <div
                    className={overviewDrafted ? 'reveal' : ''}
                    data-flash=""
                    style={{ borderRadius: 14 }}
                  >
                    <RichText
                      id="overview-editor"
                      seed={overviewSeed}
                      placeholder={`Describe the work, your approach, and what ${BRIEF.company} can expect.`}
                      onChange={(html, text) => {
                        setOverviewHtml(html);
                        setOverviewText(text);
                        setOverviewDrafted(false);
                      }}
                    />
                  </div>
                )}
              </section>

              {/* Milestones */}
              <section className="section" id="sec-milestones">
                <SectionHead
                  title="Milestones"
                  help={
                    fixed
                      ? 'What you’ll deliver. Open one to add detail and how it’s signed off.'
                      : 'Estimated hours per deliverable. They guide the estimate but don’t cap it.'
                  }
                  right={
                    msSuggested && (
                      <span className="suggest">
                        <Icon.Sparkles size={13} /> Suggested from the brief
                        <button
                          className="linkbtn"
                          onClick={() => {
                            setMilestones([blankMilestone()]);
                            setMsSuggested(false);
                          }}
                        >
                          Clear
                        </button>
                      </span>
                    )
                  }
                />
                {drafting ? (
                  <div className="ms-list">
                    <div className="sk-wrap">
                      {[0.62, 0.5, 0.56].map((w) => (
                        <div key={w} style={{ display: 'grid', gap: 8, padding: '6px 0' }}>
                          <div className="sk" style={{ width: `${w * 100}%`, height: 13 }} />
                          <div className="sk" style={{ width: `${w * 75}%` }} />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  milestones.length > 0 && (
                    <div className={`ms-list ${msSuggested ? 'reveal' : ''}`}>
                      {milestones.map((m, i) => (
                        <div
                          key={m.id}
                          className={`ms ${dragId === m.id ? 'dragging' : ''}`}
                          data-flash=""
                          draggable={armed === m.id}
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/plain', m.id);
                            setDragId(m.id);
                          }}
                          onDragOver={(e) => onDragOverRow(e, m.id)}
                          onDragEnd={() => {
                            setDragId(null);
                            setArmed(null);
                          }}
                        >
                          <div className={`ms-row ${fixed && !msPricing ? 'nocol' : ''}`}>
                            <span
                              className="grip"
                              title="Drag to reorder"
                              onMouseDown={() => setArmed(m.id)}
                              onMouseUp={() => setArmed(null)}
                            >
                              <Grip />
                            </span>
                            <span className="ms-num">{i + 1}</span>
                            <input
                              id={`m-title-${m.id}`}
                              className="ms-title"
                              value={m.title}
                              placeholder="Milestone title"
                              aria-label={`Milestone ${i + 1} title`}
                              onChange={(e) => updateM(m.id, { title: e.target.value }, true)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  addMilestone(i + 1);
                                }
                                if (e.key === 'Backspace' && !m.title && milestones.length > 1) {
                                  e.preventDefault();
                                  removeMilestone(m.id, i, true);
                                }
                              }}
                            />
                            {fixed ? (
                              msPricing && (
                                <NumField
                                  id={`m-amount-${m.id}`}
                                  prefix="A$"
                                  ariaLabel={`Milestone ${i + 1} amount`}
                                  value={
                                    m.valueCents == null ? null : Math.round(m.valueCents / 100)
                                  }
                                  onChange={(v) =>
                                    updateM(m.id, { valueCents: v == null ? null : v * 100 })
                                  }
                                />
                              )
                            ) : (
                              <NumField
                                id={`m-hours-${m.id}`}
                                suffix="h"
                                ariaLabel={`Milestone ${i + 1} estimated hours`}
                                value={m.estMinutes == null ? null : Math.round(m.estMinutes / 60)}
                                onChange={(v) =>
                                  updateM(m.id, { estMinutes: v == null ? null : v * 60 })
                                }
                              />
                            )}
                            <button
                              className="icon-btn"
                              aria-label={m.open ? 'Hide details' : 'Show details'}
                              aria-expanded={m.open}
                              onClick={() => updateM(m.id, { open: !m.open })}
                            >
                              <Icon.ChevronDown size={16} className={m.open ? 'rot' : ''} />
                            </button>
                            <button
                              className="icon-btn del"
                              aria-label={`Remove milestone ${i + 1}`}
                              onClick={() => removeMilestone(m.id, i, false)}
                            >
                              <Icon.Trash size={15} />
                            </button>
                          </div>
                          {!m.open && m.description && (
                            <button
                              className="ms-peek"
                              onClick={() => updateM(m.id, { open: true })}
                            >
                              {m.description}
                            </button>
                          )}
                          {m.open && (
                            <div className="ms-detail">
                              <div>
                                <span className="fl">What it covers</span>
                                <AutoTextarea
                                  value={m.description}
                                  placeholder="Workshops with sales ops to map your pricing rules"
                                  onChange={(v) => updateM(m.id, { description: v }, true)}
                                />
                              </div>
                              <div>
                                <span className="fl">Done when</span>
                                <AutoTextarea
                                  value={m.acceptance}
                                  placeholder="You’ve signed off the solution design"
                                  onChange={(v) => updateM(m.id, { acceptance: v }, true)}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )
                )}
                <div className="list-foot">
                  <button
                    id="add-milestone"
                    className="ghost"
                    onClick={() => addMilestone(milestones.length)}
                    disabled={drafting}
                  >
                    <Icon.Plus size={15} /> Add milestone
                  </button>
                  {!drafting &&
                    milestones.length > 0 &&
                    (fixed ? (
                      <button
                        className="switch"
                        role="switch"
                        aria-checked={msPricing}
                        onClick={toggleMsPricing}
                      >
                        <span className="track" aria-hidden="true" />
                        Price each milestone
                      </button>
                    ) : (
                      <div className="total">
                        About <strong>{totalHours} hours</strong>, estimated{' '}
                        <strong>{fmt(tmEstimate)}</strong>
                      </div>
                    ))}
                </div>
                {fixed &&
                  msPricing &&
                  !drafting &&
                  milestones.length > 0 &&
                  (() => {
                    const allPriced = milestones.every((m) => m.valueCents);
                    if (!priceCents)
                      return (
                        <div className="alloc">
                          Milestones add up to <strong>{fmt(allocated)}</strong>. Set your project
                          price below.
                        </div>
                      );
                    if (allPriced && allocated === priceCents)
                      return (
                        <div className="alloc ok">
                          <Icon.Check size={14} /> Adds up to your {fmt(priceCents)} price
                        </div>
                      );
                    const diff = priceCents - allocated;
                    return (
                      <div className="alloc warn">
                        <span>
                          {diff > 0
                            ? `${fmt(diff)} of your ${fmt(priceCents)} price left to assign`
                            : `${fmt(-diff)} over your ${fmt(priceCents)} price`}
                        </span>
                        {allPriced && (
                          <button className="linkbtn" onClick={() => setPriceCents(allocated)}>
                            Set price to {fmt(allocated)}
                          </button>
                        )}
                      </div>
                    );
                  })()}
              </section>

              {/* Payment schedule (fixed) or Rates and billing (T&M) */}
              {fixed ? (
                <section className="section" id="sec-payment">
                  {changeReq && (
                    <ChangeNote
                      cr={changeReq}
                      onToggle={() => setChangeReq((c) => ({ ...c, addressed: !c.addressed }))}
                    />
                  )}
                  <SectionHead
                    title="Price and payments"
                    help={`One price for the whole project, and how ${BRIEF.company} pays it.`}
                  />
                  <div className="price-field">
                    <Field
                      label="Project price"
                      help="The full amount you’ll receive for this project."
                    >
                      <NumField
                        id="fixed-price"
                        prefix="A$"
                        ariaLabel="Project price"
                        placeholder="15,000"
                        value={priceCents == null ? null : Math.round(priceCents / 100)}
                        onChange={(v) => setPriceCents(v == null ? null : v * 100)}
                      />
                    </Field>
                  </div>
                  <span
                    className="fl"
                    style={{ display: 'block', fontSize: 13.5, fontWeight: 500, marginBottom: 8 }}
                  >
                    Payment schedule
                  </span>
                  <div className="presets" role="group" aria-label="Payment presets">
                    {PRESETS.map((p) => (
                      <button
                        key={p.key}
                        className={`preset ${presetKey === p.key ? 'on' : ''}`}
                        aria-pressed={presetKey === p.key}
                        onClick={() => applyPreset(p.key)}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  {installments.length > 0 && (
                    <div className="inst-list">
                      {installments.map((r, i) => (
                        <div key={r.id} className="inst" data-flash="">
                          <input
                            id={`inst-label-${r.id}`}
                            className="inst-label"
                            value={r.label}
                            placeholder="Payment name"
                            aria-label={`Payment ${i + 1} name`}
                            onChange={(e) => updateInst(r.id, { label: e.target.value })}
                          />
                          <NumField
                            id={`inst-pct-${r.id}`}
                            suffix="%"
                            ariaLabel={`Payment ${i + 1} percentage`}
                            value={r.pct}
                            onChange={(v) =>
                              updateInst(r.id, { pct: v == null ? null : Math.min(100, v) })
                            }
                          />
                          <span className="inst-amt">
                            {fixedTotal ? fmt(Math.round((fixedTotal * (r.pct || 0)) / 100)) : '—'}
                          </span>
                          <button
                            className="icon-btn del"
                            aria-label={`Remove payment ${i + 1}`}
                            onClick={() => removeInst(r.id)}
                          >
                            <Icon.Trash size={15} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="list-foot">
                    <button id="add-installment" className="ghost" onClick={addInst}>
                      <Icon.Plus size={15} /> Add payment
                    </button>
                    {installments.length > 0 && (
                      <span className={`sum ${instSum === 100 ? 'ok' : 'warn'}`}>
                        {instSum === 100 ? (
                          <>
                            <Icon.Check size={14} /> Adds up to 100%
                          </>
                        ) : instSum < 100 ? (
                          `Adds up to ${instSum}%. ${100 - instSum}% left to assign.`
                        ) : (
                          `Adds up to ${instSum}%. That’s ${instSum - 100}% over.`
                        )}
                      </span>
                    )}
                  </div>
                </section>
              ) : (
                <section className="section" id="sec-rates">
                  {changeReq && (
                    <ChangeNote
                      cr={changeReq}
                      onToggle={() => setChangeReq((c) => ({ ...c, addressed: !c.addressed }))}
                    />
                  )}
                  <SectionHead
                    title="Rates and billing"
                    help={`${BRIEF.company} is billed for time worked. Milestones are a guide, not a cap.`}
                  />
                  <div className="grid2">
                    <Field
                      label="Hourly rate"
                      help="From your profile rate. Changing it here only affects this proposal."
                    >
                      <NumField
                        id="tm-rate"
                        prefix="A$"
                        suffix="/hr"
                        ariaLabel="Hourly rate"
                        value={rateCents == null ? null : Math.round(rateCents / 100)}
                        onChange={(v) => setRateCents(v == null ? null : v * 100)}
                      />
                    </Field>
                    <Field label="Deposit" help="Paid before work starts.">
                      <NumField
                        id="tm-deposit"
                        prefix="A$"
                        ariaLabel="Deposit"
                        value={depositCents == null ? null : Math.round(depositCents / 100)}
                        onChange={(v) => setDepositCents(v == null ? null : v * 100)}
                      />
                    </Field>
                  </div>
                  <Field label="Invoices">
                    <div className="seg" role="group" aria-label="Invoice cadence">
                      {[
                        ['fortnightly', 'Fortnightly'],
                        ['monthly', 'Monthly'],
                      ].map(([k, l]) => (
                        <button
                          key={k}
                          className={cadence === k ? 'on' : ''}
                          aria-pressed={cadence === k}
                          onClick={() => setCadence(k)}
                        >
                          {l}
                        </button>
                      ))}
                    </div>
                  </Field>
                </section>
              )}

              {/* Not included */}
              <section className="section" id="sec-exclusions">
                <SectionHead
                  title="Not included"
                  optional
                  help="Anything explicitly out of scope, so there are no surprises later."
                />
                <AutoTextarea
                  value={exclusions}
                  onChange={setExclusions}
                  placeholder="Migrating historical quotes from your spreadsheets"
                />
              </section>

              {/* Attachments */}
              <section className="section" id="sec-attachments">
                <SectionHead
                  title="Attachments"
                  optional
                  help="Supporting documents, or your own terms to sit alongside Balo’s."
                />
                {docs.length > 0 && (
                  <div className="docs">
                    {docs.map((d) => (
                      <div key={d.id} className="docrow">
                        <Icon.File size={16} />
                        <div className="docname">
                          {d.name}
                          <span>{fmtSize(d.size)}</span>
                        </div>
                        <span className="kindtag">
                          {d.kind === 'terms' ? 'Your terms' : 'Reference'}
                        </span>
                        <button
                          className="icon-btn del"
                          aria-label={`Remove ${d.name}`}
                          onClick={() => setDocs((ds) => ds.filter((x) => x.id !== d.id))}
                        >
                          <Icon.Trash size={15} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <label className="dropzone">
                  <input
                    ref={fileRef}
                    type="file"
                    multiple
                    hidden
                    onChange={(e) => {
                      addFiles(e.target.files);
                      e.target.value = '';
                    }}
                  />
                  <Icon.Paperclip size={16} />
                  <span>
                    Drop files anywhere on this page, or <u>browse</u>
                  </span>
                </label>
              </section>
            </>
          )}
        </main>

        {mode === 'edit' && (
          <aside className="rail" aria-label="Proposal summary">
            <div className="card">
              <div className="r-label">You receive</div>
              <div className="r-total">{totalNode}</div>
              <p className="r-sub">{totalSub}</p>
              <span className="badge-ok">
                <Icon.Shield size={13} /> 100% yours
              </span>
              <p className="r-note">
                Balo adds a service margin to the price {BRIEF.company} sees.{' '}
                <a href="#how-pricing-works">How pricing works</a>
              </p>
              <dl className="r-dl">
                <div>
                  <dt>Pricing</dt>
                  <dd>{fixed ? 'Fixed price' : 'Time and materials'}</dd>
                </div>
                <div>
                  <dt>Milestones</dt>
                  <dd>{drafting ? '—' : milestones.length}</dd>
                </div>
                <div>
                  <dt>Timeframe</dt>
                  <dd>{weeksLabel(timeframe) || 'Not set'}</dd>
                </div>
                <div>
                  <dt>{fixed ? 'Payments' : 'Billing'}</dt>
                  <dd>{paymentsSummary}</dd>
                </div>
                <div>
                  <dt>Terms</dt>
                  <dd>{termsDoc ? 'Balo and yours' : 'Balo standard'}</dd>
                </div>
              </dl>
              <div key={nudge} className={`cl ${nudge ? 'nudge' : ''}`}>
                {drafting ? (
                  <div className="cl-head ai">
                    <Icon.Sparkles size={15} /> Drafting from {BRIEF.clientFirst}’s request…
                  </div>
                ) : issues.length ? (
                  <>
                    <div className="cl-head warn">
                      <Icon.Alert size={15} /> {issues.length}{' '}
                      {plural(issues.length, 'thing', 'things')} left before you can send
                    </div>
                    {issues.map((it) => (
                      <button key={it.id} className="cl-item" onClick={() => jumpTo(it.target)}>
                        <span>{it.label}</span>
                        <Icon.ChevronRight size={14} />
                      </button>
                    ))}
                  </>
                ) : (
                  <>
                    <div className="cl-head ok">
                      <Icon.CheckCircle size={15} /> Ready to send
                    </div>
                    {soft.map((it) => (
                      <button
                        key={it.id}
                        className="cl-item soft"
                        onClick={() => jumpTo(it.target)}
                      >
                        <span>{it.label}</span>
                        <Icon.ChevronRight size={14} />
                      </button>
                    ))}
                  </>
                )}
              </div>
              <button className="cta" onClick={goPreview}>
                {ctaLabel}
              </button>
              <p className="r-foot">Nothing is sent until you confirm in the preview.</p>
            </div>
          </aside>
        )}
      </div>

      {mode === 'edit' && (
        <div className="mbar">
          <div>
            <div className="mbar-total">
              {fixed ? (priceCents ? fmt(priceCents) : '—') : `${fmt(rateCents)}/hr`}
            </div>
            {issues.length ? (
              <button className="mbar-sub" onClick={() => jumpTo(issues[0].target)}>
                {issues.length} {plural(issues.length, 'thing', 'things')} left
              </button>
            ) : (
              <div className="mbar-sub ok">{drafting ? 'Drafting…' : 'Ready to send'}</div>
            )}
          </div>
          <button className="cta cta-sm" onClick={goPreview}>
            {ctaLabel}
          </button>
        </div>
      )}

      {dropActive && (
        <div className="drop-overlay">
          <div>
            <Icon.Paperclip size={18} /> Drop to attach to your proposal
          </div>
        </div>
      )}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.msg}</span>
          {toast.undo && (
            <button
              onClick={() => {
                toast.undo();
                setToast(null);
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}
