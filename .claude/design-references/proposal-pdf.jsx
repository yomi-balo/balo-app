import React from 'react';

// ─────────────────────────────────────────────────────────────────────────────────────
// Balo — Client-facing proposal PDF — VISUAL REFERENCE (BAL-385 / BAL-392)
//
// This is an eyeball-only mockup of the approved A4 layout, rendered in
// plain HTML/CSS so anyone reading the repo can open it in a browser and
// see what the generated PDF is meant to look like.
//
// ⚠️ NOT the render source. The real PDF is built with @react-pdf/renderer
// (flexbox primitives, no HTML/CSS) at:
//   apps/web/src/lib/project-request/proposal/pdf/proposal-pdf-document.tsx
// Change that file (and its theme in pdf-theme.ts) to alter the real output —
// editing this reference changes nothing that ships.
//
// LAYOUT (approved 2026-07-14, revised 2026-07-17 per BAL-392):
//   • Balo-branded header (wordmark + pricing-method pill), fixed on every page
//   • Title + version note
//   • Prepared-for / prepared-by (company / individual "@ agency")
//   • SUMMARY BOX — total on top, then a FOUR-cell detail grid:
//       pricing method · estimated timeline · payment terms · deliverables count
//     (page 1 only; "know the shape of the deal at a glance")
//   • Overview
//   • Milestones & deliverables — each with title, value (Fixed), and DESCRIPTION
//   • Payment terms · Not included · Attachments · Balo standard terms
//   • Footer (version + generated date + page N of M), fixed on every page
//
// HARD RULE: every money figure is the CLIENT price (through applyBaloFee).
// The Balo fee %, raw expert quote, and admin pricing never appear here —
// the document consumes only a `client`-audience ProposalReviewDoc.
// ─────────────────────────────────────────────────────────────────────────────────────

const c = {
  page: '#FFFFFF',
  ink: '#0F172A',
  muted: '#64748B',
  faint: '#94A3B8',
  border: '#E2E8F0',
  hair: '#EEF1F5',
  subtleBg: '#F8FAFC',
  brand: '#0C64F4',
  brandSoft: '#EFF4FF',
  brandBorder: '#C7DBFF',
  successText: '#15803D',
};

const FileText = ({ size = 12, color = c.faint }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
  </svg>
);

// Fixture — mirrors the composer's $12,500 expert quote grossed through a 25%
// Balo fee (→ $15,625 client). All figures shown are CLIENT-facing.
const P = {
  title: 'Salesforce CPQ Implementation — Phase 1',
  version: 3,
  preparedFor: 'Acme Industrial',
  preparedForAttn: 'Attn: Dana Okafor',
  preparedBy: 'Priya Raman @ Meridian Consulting',
  pricingMethod: 'Fixed price',
  total: '$15,625',
  timeline: '~8 weeks',
  paymentTerms: '30% upfront',
  overview:
    'A phased implementation of Salesforce CPQ covering discovery, configuration of pricing and quoting rules, data migration, and user enablement for the Acme sales organisation.',
  milestones: [
    [
      'Discovery & solution design',
      '$3,125',
      'Stakeholder workshops, current-state review, and a documented target CPQ architecture.',
    ],
    [
      'CPQ configuration & pricing rules',
      '$6,250',
      'Product bundles, discount schedules, approval flows, and quote templates built and configured.',
    ],
    [
      'Data migration & validation',
      '$3,125',
      'Migration of existing product and pricing data, with reconciliation against source records.',
    ],
    [
      'UAT support & team training',
      '$3,125',
      'Guided user-acceptance testing plus two enablement sessions for the sales team.',
    ],
  ],
  installments: [
    ['On acceptance', 30, '$4,688'],
    ['Midpoint', 40, '$6,250'],
    ['On completion', 30, '$4,687'],
  ],
  exclusions:
    'Third-party license costs and ongoing managed support beyond the training period are not included.',
  attachments: ['Solution architecture overview.pdf', 'Reference implementation — case study.pdf'],
  standardTerms: [
    'Work is delivered through Balo; payment is handled by Balo, not directly with the expert.',
    'Either party may raise issues through Balo support during the engagement.',
    'Balo standard service terms and privacy policy apply to this proposal.',
  ],
  generatedDate: '14 July 2026',
};

const Label = ({ children, style }) => (
  <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', color: c.muted, ...style }}>
    {children}
  </div>
);

export default function ProposalPdfReference() {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#EEF1F5',
        padding: '32px 16px',
        fontFamily: "'Geist', system-ui, sans-serif",
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 16,
      }}
    >
      <div style={{ maxWidth: 620, width: '100%', fontSize: 12, color: c.muted, lineHeight: 1.5 }}>
        Visual reference only — the shipping PDF is generated with @react-pdf/renderer at{' '}
        <code style={{ fontSize: 11 }}>
          apps/web/src/lib/project-request/proposal/pdf/proposal-pdf-document.tsx
        </code>
        . Editing this file changes nothing that ships.
      </div>

      {/* A4 page — 210:297 ratio */}
      <div
        style={{
          width: 620,
          aspectRatio: '210 / 297',
          background: c.page,
          color: c.ink,
          boxShadow: '0 8px 28px rgba(15,23,42,0.14)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '30px 40px 0', flex: 1, display: 'flex', flexDirection: 'column' }}>
          {/* Header — fixed on every page in the real doc */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 16,
            }}
          >
            <span
              style={{ fontSize: 18, fontWeight: 700, color: c.brand, letterSpacing: '-0.4px' }}
            >
              Balo
            </span>
            <span
              style={{
                fontSize: 9,
                fontWeight: 600,
                color: c.brand,
                background: c.brandSoft,
                border: `1px solid ${c.brandBorder}`,
                borderRadius: 999,
                padding: '3px 9px',
              }}
            >
              {P.pricingMethod}
            </span>
          </div>

          <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.01em' }}>{P.title}</div>
          <div style={{ fontSize: 9, color: c.faint, marginTop: 3 }}>
            {P.version > 1 ? `Version ${P.version} · revised` : `Version ${P.version}`}
          </div>

          {/* Parties */}
          <div style={{ display: 'flex', gap: 28, marginTop: 14 }}>
            <div style={{ flex: 1 }}>
              <Label>PREPARED FOR</Label>
              <div style={{ fontSize: 10, fontWeight: 600, marginTop: 3 }}>{P.preparedFor}</div>
              <div style={{ fontSize: 9, color: c.muted }}>{P.preparedForAttn}</div>
            </div>
            <div style={{ flex: 1 }}>
              <Label>PREPARED BY</Label>
              <div style={{ fontSize: 10, fontWeight: 600, marginTop: 3 }}>{P.preparedBy}</div>
            </div>
          </div>

          {/* ★ SUMMARY BOX — total + four-cell detail grid (BAL-392) */}
          <div
            style={{
              marginTop: 16,
              border: `1px solid ${c.border}`,
              borderRadius: 10,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-end',
                padding: '14px 16px',
                background: c.brandSoft,
                borderBottom: `1px solid ${c.brandBorder}`,
              }}
            >
              <Label style={{ color: c.muted }}>TOTAL AMOUNT</Label>
              <div
                style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.01em', lineHeight: 1 }}
              >
                {P.total}
              </div>
            </div>
            <div style={{ display: 'flex' }}>
              {[
                ['PRICING', P.pricingMethod],
                ['EST. TIMELINE', P.timeline],
                ['PAYMENT', P.paymentTerms],
                ['DELIVERABLES', `${P.milestones.length} items`],
              ].map(([label, value], i) => (
                <div
                  key={label}
                  style={{
                    flex: 1,
                    padding: '10px 14px',
                    borderRight: i < 3 ? `1px solid ${c.hair}` : 'none',
                  }}
                >
                  <Label style={{ fontSize: 7.5, letterSpacing: '0.06em' }}>{label}</Label>
                  <div style={{ fontSize: 10, fontWeight: 600, marginTop: 3 }}>{value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Overview */}
          <div style={{ marginTop: 18 }}>
            <Label style={{ letterSpacing: '0.09em' }}>OVERVIEW</Label>
            <div style={{ fontSize: 9.5, lineHeight: 1.6, color: '#334155', marginTop: 6 }}>
              {P.overview}
            </div>
          </div>

          {/* Milestones & deliverables — title + value + description */}
          <div style={{ marginTop: 18 }}>
            <Label style={{ letterSpacing: '0.09em' }}>MILESTONES &amp; DELIVERABLES</Label>
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 7 }}>
              {P.milestones.map(([title, value, desc], i) => (
                <div
                  key={title}
                  style={{ border: `1px solid ${c.border}`, borderRadius: 8, padding: 11 }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                    <span style={{ fontSize: 10, fontWeight: 600, flex: 1 }}>
                      {i + 1}. {title}
                    </span>
                    <span style={{ fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap' }}>
                      {value}
                    </span>
                  </div>
                  <div style={{ fontSize: 9, color: c.muted, lineHeight: 1.5, marginTop: 4 }}>
                    {desc}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Payment terms */}
          <div style={{ marginTop: 18 }}>
            <Label style={{ letterSpacing: '0.09em' }}>PAYMENT TERMS</Label>
            <div
              style={{
                marginTop: 6,
                border: `1px solid ${c.border}`,
                borderRadius: 8,
                padding: 12,
              }}
            >
              {P.installments.map(([label, pct, amount]) => (
                <div
                  key={label}
                  style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}
                >
                  <span style={{ fontSize: 10, fontWeight: 600 }}>
                    {label} — {amount}
                  </span>
                  <span style={{ fontSize: 9, color: c.muted }}>{pct}%</span>
                </div>
              ))}
            </div>
          </div>

          {/* Not included */}
          <div style={{ marginTop: 18 }}>
            <Label style={{ letterSpacing: '0.09em' }}>NOT INCLUDED</Label>
            <div style={{ fontSize: 9.5, lineHeight: 1.6, color: '#334155', marginTop: 6 }}>
              {P.exclusions}
            </div>
          </div>

          {/* Attachments */}
          <div style={{ marginTop: 18 }}>
            <Label style={{ letterSpacing: '0.09em' }}>ATTACHMENTS</Label>
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {P.attachments.map((name) => (
                <div
                  key={name}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    border: `1px solid ${c.border}`,
                    borderRadius: 8,
                    padding: '8px 11px',
                  }}
                >
                  <FileText />
                  <span style={{ fontSize: 9, fontWeight: 600 }}>{name}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Standard terms */}
          <div style={{ marginTop: 18 }}>
            <Label style={{ letterSpacing: '0.09em' }}>TERMS</Label>
            <div
              style={{
                marginTop: 6,
                border: `1px solid ${c.border}`,
                background: c.subtleBg,
                borderRadius: 8,
                padding: 12,
              }}
            >
              <div style={{ fontSize: 10, fontWeight: 600, marginBottom: 5 }}>
                Balo standard terms apply
              </div>
              {P.standardTerms.map((term) => (
                <div key={term} style={{ display: 'flex', gap: 6, marginBottom: 3 }}>
                  <span style={{ fontSize: 9, color: c.muted }}>•</span>
                  <span style={{ flex: 1, fontSize: 9, color: c.muted, lineHeight: 1.5 }}>
                    {term}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div style={{ flex: 1 }} />

          {/* Footer — fixed on every page in the real doc */}
          <div style={{ padding: '12px 0 20px', textAlign: 'center', fontSize: 8, color: c.faint }}>
            Version {P.version} · Generated {P.generatedDate} · Page 1 of 1
          </div>
        </div>
      </div>
    </div>
  );
}
