import { Document, Page, StyleSheet, Text, View, renderToBuffer } from '@react-pdf/renderer';
import { durationLine, finalizedAmountMinor } from '@balo/shared/credit';
import { personWithOrgLabel } from '@balo/shared/parties';
import { formatAud } from '@/lib/credit/display-constants';
import { formatLongUtc } from '@/lib/format/utc-date';
import { PDF_COLORS, PDF_TYPE } from '@/lib/project-request/proposal/pdf/pdf-theme';
import {
  ensurePdfFontsRegistered,
  PDF_FONT_FAMILY,
} from '@/lib/project-request/proposal/pdf/pdf-fonts';
import type { SessionStatementView } from '@/app/(dashboard)/sessions/[sessionId]/_lib/session-statement-view';
import {
  STATEMENT_COPY,
  STATEMENT_SHARED_COPY,
  PAYOUT_STATUS_LABELS,
  PAYOUT_STATUS_COPY,
  pdfPageLine,
} from '@/app/(dashboard)/sessions/[sessionId]/_lib/statement-copy';

// Register Geist once at module load — the house pattern (`proposal-pdf-document.tsx:15`);
// never a silent Helvetica fallback (`pdf-fonts.ts` deliberately provides none).
ensurePdfFontsRegistered();

/**
 * BAL-441 (owner decision D-C, mechanism corrected per plan §C1) — the session statement PDF.
 *
 * ⚠⚠ FEE CONCEALMENT IS STRUCTURAL, NOT A REVIEW CHECKLIST. This document's ONLY input is a
 * `SessionStatementView` — the SAME lens-resolved view the page renders, never a widened one.
 * The client arm's TypeScript shape has no `payout` field and no expert-earnings figure; the
 * expert arm's shape has no `ratePerMinuteMinor` and no client charge. The wrong-lens fields are
 * UNREPRESENTABLE, so a bug here cannot leak one across the boundary.
 */
export interface SessionStatementPdfDocumentProps {
  view: SessionStatementView;
}

const styles = StyleSheet.create({
  page: {
    fontFamily: PDF_FONT_FAMILY,
    fontSize: PDF_TYPE.body,
    color: PDF_COLORS.text,
    paddingTop: 44,
    paddingBottom: 56,
    paddingHorizontal: 48,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 18,
  },
  wordmark: { fontSize: 18, fontWeight: 700, color: PDF_COLORS.brand, letterSpacing: -0.4 },
  pill: {
    fontSize: PDF_TYPE.small,
    fontWeight: 600,
    color: PDF_COLORS.brand,
    backgroundColor: PDF_COLORS.brandSoft,
    borderWidth: 1,
    borderColor: PDF_COLORS.brandBorder,
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 9,
  },
  title: { fontSize: PDF_TYPE.title, fontWeight: 700, color: PDF_COLORS.text, marginTop: 4 },
  meta: { fontSize: PDF_TYPE.small, color: PDF_COLORS.muted, marginTop: 6 },
  section: { marginTop: 20 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: PDF_COLORS.border,
    paddingVertical: 7,
  },
  rowLabel: { fontSize: PDF_TYPE.body, color: PDF_COLORS.muted },
  rowValue: { fontSize: PDF_TYPE.body, fontWeight: 600, color: PDF_COLORS.text },
  subLine: { fontSize: PDF_TYPE.small, color: PDF_COLORS.muted, marginTop: 2 },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 2,
    borderTopColor: PDF_COLORS.text,
    marginTop: 4,
    paddingTop: 10,
  },
  totalLabel: { fontSize: PDF_TYPE.h3, fontWeight: 700, color: PDF_COLORS.text },
  totalValue: { fontSize: PDF_TYPE.money, fontWeight: 700, color: PDF_COLORS.text },
  statement: { fontSize: PDF_TYPE.h2, fontWeight: 600, color: PDF_COLORS.text, marginTop: 24 },
  statusBox: {
    borderWidth: 1,
    borderColor: PDF_COLORS.border,
    borderRadius: 8,
    padding: 12,
    marginTop: 20,
  },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  footer: {
    position: 'absolute',
    bottom: 26,
    left: 48,
    right: 48,
    fontSize: PDF_TYPE.label,
    color: PDF_COLORS.faint,
    textAlign: 'center',
  },
});

function LineItems({ view }: Readonly<{ view: SessionStatementView }>): React.JSX.Element {
  const copy = STATEMENT_COPY[view.lens];
  const line = durationLine(view.block);
  const bareDuration = `${view.block.durationMinutes} min`;
  const subLine = line === bareDuration ? null : line;
  const total = finalizedAmountMinor(view.block);

  return (
    <View style={styles.section}>
      {view.lens === 'client' ? (
        <View style={styles.row}>
          <Text style={styles.rowLabel}>{STATEMENT_SHARED_COPY.rateRowLabel}</Text>
          <Text style={styles.rowValue}>{formatAud(view.block.ratePerMinuteMinor)}</Text>
        </View>
      ) : null}
      <View style={styles.row}>
        <View>
          <Text style={styles.rowLabel}>{copy.durationRowLabel}</Text>
          {subLine === null ? null : <Text style={styles.subLine}>{subLine}</Text>}
        </View>
        <Text style={styles.rowValue}>{bareDuration}</Text>
      </View>
      <View style={styles.totalRow}>
        <Text style={styles.totalLabel}>{copy.totalRowLabel}</Text>
        <Text style={styles.totalValue}>{formatAud(total)}</Text>
      </View>
    </View>
  );
}

function PayoutStatusRows({
  view,
}: Readonly<{ view: Extract<SessionStatementView, { lens: 'expert' }> }>) {
  if (view.block.payoutStatus === undefined) {
    return null;
  }
  return (
    <View style={styles.statusBox}>
      <View style={styles.statusRow}>
        <Text style={styles.rowLabel}>{STATEMENT_SHARED_COPY.payoutStatusRowLabel}</Text>
        {/*
          ⚠ THE HUMANE LABEL, NEVER THE RAW ENUM. This used to render `view.block.payoutStatus`
          directly, so the downloadable file said "recorded" while the page it was downloaded
          from said "Booked" — a different word on the artefact an expert actually forwards. The
          PDF and the page must speak the same language; both read `PAYOUT_STATUS_LABELS`.
        */}
        <Text style={styles.rowValue}>{PAYOUT_STATUS_LABELS[view.block.payoutStatus]}</Text>
      </View>
      {/* The reassurance line the page shows too — dropping it made the PDF terser than the
          screen for no reason, and `failed` is precisely where the reader needs it. */}
      <View style={styles.statusRow}>
        <Text style={styles.subLine}>{PAYOUT_STATUS_COPY[view.block.payoutStatus]}</Text>
      </View>
      {view.payout === null ? null : (
        <>
          <View style={styles.statusRow}>
            <Text style={styles.rowLabel}>{STATEMENT_SHARED_COPY.payoutRecordedRowLabel}</Text>
            <Text style={styles.rowValue}>
              {formatLongUtc(new Date(view.payout.recordedAtIso))}
            </Text>
          </View>
          <View style={styles.statusRow}>
            <Text style={styles.rowLabel}>{STATEMENT_SHARED_COPY.payoutReferenceRowLabel}</Text>
            <Text style={styles.rowValue}>{view.payout.reference}</Text>
          </View>
        </>
      )}
    </View>
  );
}

/** ONE document, lens-branched. Ternary-to-`null`, never `&&` on a number (BAL-441 house rule). */
export function SessionStatementPdfDocument({
  view,
}: Readonly<SessionStatementPdfDocumentProps>): React.JSX.Element {
  const copy = STATEMENT_COPY[view.lens];
  const title = view.title ?? copy.fallbackTitle;
  const counterpartyLine = personWithOrgLabel(view.counterparty.name, view.counterparty.orgLabel);
  const dateLine = view.occurredAtIso === null ? null : formatLongUtc(new Date(view.occurredAtIso));
  // ⚠ MONEY MODE ONLY — ENFORCED, NOT ASSUMED (review F8, owner decision D-C).
  //
  // D-C is explicit that the zero-money and cancelled shapes get NO PDF: there is nothing to
  // forward for a call that was never billed. Both Route Handlers already 404 those via
  // `isStatementDownloadable`, so this branch was unreachable in production and was kept alive
  // only by a test of a path no caller can produce — coverage for a document that must not exist.
  //
  // Replacing the silent alternate rendering with a throw makes the decision load-bearing here
  // rather than only at the two call sites: a future third caller that forgets the gate gets a
  // 500 and a Sentry event, not a quietly-generated statement contradicting D-C.
  if (view.mode.kind !== 'money') {
    throw new Error(`Refusing to render a statement PDF for mode "${view.mode.kind}" (D-C)`);
  }

  return (
    <Document title={title} author="Balo">
      <Page size="A4" style={styles.page}>
        <View style={styles.header} fixed>
          <Text style={styles.wordmark}>Balo</Text>
          <Text style={styles.pill}>{copy.eyebrow}</Text>
        </View>

        <Text style={styles.title}>{title}</Text>
        <Text style={styles.meta}>
          {dateLine === null ? STATEMENT_SHARED_COPY.datePending : dateLine} ·{' '}
          {STATEMENT_SHARED_COPY.counterpartyPrefix} {counterpartyLine}
        </Text>

        <LineItems view={view} />

        {view.lens === 'expert' ? <PayoutStatusRows view={view} /> : null}

        <Text
          style={styles.footer}
          fixed
          render={({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
            `${copy.footerNote} · ${pdfPageLine(pageNumber, totalPages)}`
          }
        />
      </Page>
    </Document>
  );
}

/** Render the statement PDF to a Node Buffer. Kept `.tsx` so the Route Handler stays JSX-free. */
export function renderSessionStatementPdfToBuffer(
  props: Readonly<SessionStatementPdfDocumentProps>
): Promise<Buffer> {
  return renderToBuffer(<SessionStatementPdfDocument {...props} />);
}
