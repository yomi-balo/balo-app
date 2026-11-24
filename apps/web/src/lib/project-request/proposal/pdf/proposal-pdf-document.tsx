import { Document, Link, Page, StyleSheet, Text, View, renderToBuffer } from '@react-pdf/renderer';
import { formatWholeCurrency } from '@/lib/utils/currency';
import {
  BALO_TERMS_ADDITIVE_SENTENCE,
  STANDARD_TERMS,
  pricingMethodRule,
} from '@/components/balo/project-request/proposal/proposal-standard-terms';
import {
  buildProposalSummaryCells,
  pricingMethodLabel,
  proposalTotalLabel,
} from '@/components/balo/project-request/proposal/proposal-summary-cells';
import type {
  ProposalReviewDoc,
  ProposalReviewMilestone,
} from '@/components/balo/project-request/proposal/proposal-review-types';
import { PDF_COLORS, PDF_TYPE } from './pdf-theme';
import { ensurePdfFontsRegistered, PDF_FONT_FAMILY } from './pdf-fonts';
import { richTextToPdf } from './rich-text-to-pdf';

// Register Geist once at module load so both the route and the render tests embed
// genuine brand type (never a silent Helvetica fallback — see pdf-fonts.ts).
ensurePdfFontsRegistered();

/**
 * The Balo-branded, CLIENT-FACING proposal PDF (BAL-385). Consumes ONLY a
 * `ProposalReviewDoc` hydrated with the `client` audience — every money figure is
 * the marked-up client price and `adminPricing` is structurally absent, so the
 * Balo fee / raw expert quote can never reach this document. It deliberately does
 * NOT render the mutable acceptance status (`doc.status`): the per-proposalId R2
 * cache is immutable within a version, so a status change must not stale it.
 */
export interface ProposalPdfDocumentProps {
  /** Client-audience proposal doc (money already grossed through `applyBaloFee`). */
  doc: ProposalReviewDoc;
  /** The project request title (route-scope — not carried on the doc). */
  title: string;
  /** The client company the proposal is prepared for (prospective/party attribution). */
  clientCompanyName: string;
  /** The author's agency name for retrospective "@ org" attribution, or null (independent). */
  preparedByOrgName: string | null;
  /** ISO timestamp stamped into the every-page footer. */
  generatedAtIso: string;
  /** Absolute URL of the public Projects MSA page, printed in the terms box. */
  projectTermsUrl: string;
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
  title: { fontSize: PDF_TYPE.title, fontWeight: 700, color: PDF_COLORS.text },
  versionNote: { fontSize: PDF_TYPE.small, color: PDF_COLORS.muted, marginTop: 3 },
  parties: { flexDirection: 'row', gap: 28, marginTop: 14, marginBottom: 4 },
  party: { flex: 1 },
  partyLabel: {
    fontSize: PDF_TYPE.label,
    fontWeight: 700,
    color: PDF_COLORS.faint,
    letterSpacing: 0.6,
    marginBottom: 3,
  },
  partyValue: { fontSize: PDF_TYPE.body, fontWeight: 600, color: PDF_COLORS.text },
  summaryBox: {
    marginTop: 16,
    borderWidth: 1,
    borderColor: PDF_COLORS.border,
    borderRadius: 10,
    overflow: 'hidden',
  },
  summaryTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingVertical: 14,
    paddingHorizontal: 16,
    backgroundColor: PDF_COLORS.brandSoft,
    borderBottomWidth: 1,
    borderBottomColor: PDF_COLORS.brandBorder,
  },
  summaryTotalLabel: {
    fontSize: PDF_TYPE.label,
    fontWeight: 700,
    color: PDF_COLORS.muted,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  summaryGrid: { flexDirection: 'row' },
  summaryCell: { flex: 1, paddingVertical: 10, paddingHorizontal: 14 },
  summaryCellDivider: { borderRightWidth: 1, borderRightColor: PDF_COLORS.hair },
  summaryCellLabel: {
    fontSize: PDF_TYPE.microLabel,
    fontWeight: 700,
    color: PDF_COLORS.muted,
    letterSpacing: 0.45,
    textTransform: 'uppercase',
  },
  summaryCellValue: {
    fontSize: PDF_TYPE.body,
    fontWeight: 600,
    color: PDF_COLORS.text,
    marginTop: 3,
    // The composed PAYMENT string can still exceed the 95.32 pt cell even under the
    // shared char threshold — clamp rather than wrap, so the box geometry never breaks.
    maxLines: 1,
    textOverflow: 'ellipsis',
  },
  money: { fontSize: PDF_TYPE.money, fontWeight: 700, color: PDF_COLORS.text },
  moneyEst: { fontSize: PDF_TYPE.body, fontWeight: 600, color: PDF_COLORS.muted },
  section: { marginTop: 18 },
  sectionLabel: {
    fontSize: PDF_TYPE.label,
    fontWeight: 700,
    color: PDF_COLORS.muted,
    letterSpacing: 0.8,
    marginBottom: 7,
  },
  milestone: {
    borderWidth: 1,
    borderColor: PDF_COLORS.border,
    borderRadius: 8,
    padding: 11,
    marginBottom: 7,
  },
  milestoneHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  milestoneTitle: { fontSize: PDF_TYPE.body, fontWeight: 600, color: PDF_COLORS.text, flex: 1 },
  milestoneValue: { fontSize: PDF_TYPE.body, fontWeight: 700, color: PDF_COLORS.text },
  acceptance: { fontSize: PDF_TYPE.small, color: PDF_COLORS.muted, marginTop: 5 },
  acceptanceLead: { fontWeight: 600, color: PDF_COLORS.successText },
  richWrap: { marginTop: 4 },
  termsBox: {
    borderWidth: 1,
    borderColor: PDF_COLORS.border,
    backgroundColor: PDF_COLORS.subtleBg,
    borderRadius: 8,
    padding: 12,
  },
  termsHeading: {
    fontSize: PDF_TYPE.body,
    fontWeight: 600,
    color: PDF_COLORS.text,
    marginBottom: 5,
  },
  termRow: { flexDirection: 'row', gap: 6, marginBottom: 3 },
  termMarker: { fontSize: PDF_TYPE.small, color: PDF_COLORS.muted },
  clauseNumber: { fontSize: PDF_TYPE.small, color: PDF_COLORS.muted, minWidth: 16 },
  clauseHeading: {
    fontSize: PDF_TYPE.label,
    fontWeight: 700,
    color: PDF_COLORS.faint,
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  clauseGroupGap: { marginTop: 10 },
  // The two parts of a Terms box with additional terms: one border, split where the parts meet.
  termsBoxTop: {
    borderBottomWidth: 0,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    paddingBottom: 0,
  },
  termsBoxRest: {
    borderTopWidth: 0,
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
    paddingTop: 10,
  },
  termText: { fontSize: PDF_TYPE.small, color: PDF_COLORS.muted, lineHeight: 1.5 },
  // Only beside a number or marker in a row: in a column, flex 1 collapses the text to no height.
  termRowText: { flex: 1 },
  paymentBox: {
    borderWidth: 1,
    borderColor: PDF_COLORS.border,
    borderRadius: 8,
    padding: 12,
  },
  paymentRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
  },
  paymentLabel: { fontSize: PDF_TYPE.body, fontWeight: 600, color: PDF_COLORS.text },
  paymentPct: { fontSize: PDF_TYPE.small, color: PDF_COLORS.muted },
  tmLine: { fontSize: PDF_TYPE.body, color: PDF_COLORS.text, lineHeight: 1.5 },
  attachment: {
    borderWidth: 1,
    borderColor: PDF_COLORS.border,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 11,
    marginBottom: 6,
  },
  attachmentName: { fontSize: PDF_TYPE.small, fontWeight: 600, color: PDF_COLORS.text },
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

function formatGeneratedDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

function SectionLabel({ children }: Readonly<{ children: string }>): React.JSX.Element {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

function Parties({
  clientCompanyName,
  preparedBy,
}: Readonly<{ clientCompanyName: string; preparedBy: string }>): React.JSX.Element {
  return (
    <View style={styles.parties}>
      <View style={styles.party}>
        <Text style={styles.partyLabel}>PREPARED FOR</Text>
        <Text style={styles.partyValue}>{clientCompanyName}</Text>
      </View>
      <View style={styles.party}>
        <Text style={styles.partyLabel}>PREPARED BY</Text>
        <Text style={styles.partyValue}>{preparedBy}</Text>
      </View>
    </View>
  );
}

/**
 * The at-a-glance summary box (BAL-392): the total on top, then the four-cell detail
 * grid. Page 1 only and deliberately NOT `fixed` — it sits in normal flow under the
 * parties block. react-pdf has no CSS grid, so the row is nested `flexDirection: 'row'`
 * views with `flex: 1` children and a hairline `borderRight` on every cell but the last.
 *
 * ⚠ HOOK-FREE ON PURPOSE. The test harness's `collectText()` invokes function components
 * directly to reach their text; a hook here would break every PDF branch test. Do not add
 * `useMemo` — `buildProposalSummaryCells` is a plain call.
 */
function SummaryBox({ doc }: Readonly<{ doc: ProposalReviewDoc }>): React.JSX.Element {
  const isTM = doc.pricingMethod === 'tm';
  const cells = buildProposalSummaryCells(doc);
  const lastIndex = cells.length - 1;
  return (
    <View style={styles.summaryBox}>
      <View style={styles.summaryTotalRow}>
        <Text style={styles.summaryTotalLabel}>{proposalTotalLabel(doc.pricingMethod)}</Text>
        <Text style={styles.money}>
          {formatWholeCurrency(doc.priceCents, doc.currency)}
          {isTM ? <Text style={styles.moneyEst}> est.</Text> : null}
        </Text>
      </View>
      <View style={styles.summaryGrid}>
        {cells.map((cell, index) => (
          <View
            key={cell.key}
            style={
              index < lastIndex
                ? [styles.summaryCell, styles.summaryCellDivider]
                : styles.summaryCell
            }
          >
            <Text style={styles.summaryCellLabel}>{cell.label}</Text>
            <Text style={styles.summaryCellValue}>{cell.value}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function MilestoneRow({
  milestone,
  index,
  showValue,
  currency,
}: Readonly<{
  milestone: ProposalReviewMilestone;
  index: number;
  showValue: boolean;
  currency: string;
}>): React.JSX.Element {
  const valueCents = milestone.valueCents ?? 0;
  const description = richTextToPdf(milestone.descriptionHtml);
  const hasAcceptance =
    milestone.acceptanceCriteria !== null && milestone.acceptanceCriteria !== '';
  return (
    <View style={styles.milestone} wrap={false}>
      <View style={styles.milestoneHead}>
        <Text style={styles.milestoneTitle}>
          {index + 1}. {milestone.title}
        </Text>
        {showValue && valueCents > 0 ? (
          <Text style={styles.milestoneValue}>{formatWholeCurrency(valueCents, currency)}</Text>
        ) : null}
      </View>
      {description.length > 0 ? <View style={styles.richWrap}>{description}</View> : null}
      {hasAcceptance ? (
        <Text style={styles.acceptance}>
          <Text style={styles.acceptanceLead}>Done when: </Text>
          {milestone.acceptanceCriteria}
        </Text>
      ) : null}
    </View>
  );
}

function PaymentTerms({ doc }: Readonly<{ doc: ProposalReviewDoc }>): React.JSX.Element {
  if (doc.pricingMethod === 'tm') {
    const deposit =
      doc.depositCents === null
        ? null
        : `${formatWholeCurrency(doc.depositCents, doc.currency)} deposit on acceptance`;
    const rate =
      doc.rateCents === null ? null : `${formatWholeCurrency(doc.rateCents, doc.currency)}/hr`;
    const invoiced = doc.cadence === null ? null : `Invoiced ${doc.cadence}`;
    const parts = [deposit, rate, invoiced].filter((part): part is string => part !== null);
    return (
      <View style={styles.paymentBox}>
        <Text style={styles.tmLine}>
          {parts.length > 0 ? `${parts.join(', then ')}. ` : ''}
          {formatWholeCurrency(doc.priceCents, doc.currency)} is an estimate, not a cap.
        </Text>
      </View>
    );
  }
  // No installment schedule → the price is due in full. Show that as a single line
  // rather than an empty bordered box.
  if (doc.installments.length === 0) {
    return (
      <View style={styles.paymentBox}>
        <Text style={styles.tmLine}>
          Full amount: {formatWholeCurrency(doc.priceCents, doc.currency)}, due in full.
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.paymentBox}>
      {doc.installments.map((installment) => (
        <View key={installment.id} style={styles.paymentRow}>
          <Text style={styles.paymentLabel}>
            {installment.label} —{' '}
            {formatWholeCurrency(
              Math.round((doc.priceCents * installment.pct) / 100),
              doc.currency
            )}
          </Text>
          <Text style={styles.paymentPct}>{installment.pct}%</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * A numbered list of plain-text clauses, printed exactly as typed (no rich-text conversion).
 * A repeated body is legal, so each key carries the body plus its occurrence count. `lead` (the
 * headings above the list) moves to a new page together with the first row, never alone.
 */
function NumberedRows({
  items,
  lead,
}: Readonly<{ items: readonly string[]; lead?: React.ReactNode }>): React.JSX.Element {
  const seen = new Map<string, number>();
  const rows = items.map((item, position) => {
    const occurrence = (seen.get(item) ?? 0) + 1;
    seen.set(item, occurrence);
    return (
      <View key={`${item}::${occurrence}`} style={styles.termRow} wrap={false}>
        <Text style={styles.clauseNumber}>{position + 1}.</Text>
        <Text style={[styles.termText, styles.termRowText]}>{item}</Text>
      </View>
    );
  });
  const [first, ...rest] = rows;
  return (
    <View>
      <View wrap={false}>
        {lead}
        {first}
      </View>
      {rest}
    </View>
  );
}

function AssumptionsAndExclusions({
  doc,
}: Readonly<{ doc: ProposalReviewDoc }>): React.JSX.Element {
  const sectionLabel = <SectionLabel>ASSUMPTIONS AND EXCLUSIONS</SectionLabel>;
  const hasAssumptions = doc.assumptions.length > 0;
  return (
    <View style={styles.section}>
      {hasAssumptions ? (
        <NumberedRows
          items={doc.assumptions}
          lead={
            <>
              {sectionLabel}
              <Text style={styles.clauseHeading}>ASSUMPTIONS</Text>
            </>
          }
        />
      ) : null}
      {doc.exclusions.length > 0 ? (
        <View style={hasAssumptions ? styles.clauseGroupGap : undefined}>
          <NumberedRows
            items={doc.exclusions}
            lead={
              <>
                {hasAssumptions ? null : sectionLabel}
                <Text style={styles.clauseHeading}>NOT INCLUDED</Text>
              </>
            }
          />
        </View>
      ) : null}
    </View>
  );
}

/**
 * The TERMS section. Balo's standard terms are short and move as one block with the section
 * label. The expert's additional terms (up to 20) continue in a second part of the same box,
 * which may run onto the next page.
 */
function StandardTerms({
  pricingMethod,
  clientCompanyName,
  expertName,
  additionalTerms,
  projectTermsUrl,
}: Readonly<{
  pricingMethod: 'fixed' | 'tm';
  clientCompanyName: string;
  expertName: string;
  additionalTerms: readonly string[];
  projectTermsUrl: string;
}>): React.JSX.Element {
  const hasAdditional = additionalTerms.length > 0;
  return (
    <View style={styles.section}>
      <View wrap={false}>
        <SectionLabel>TERMS</SectionLabel>
        <View style={hasAdditional ? [styles.termsBox, styles.termsBoxTop] : styles.termsBox}>
          <Text style={styles.termsHeading}>Balo Project T&amp;Cs apply</Text>
          <Text style={styles.termText}>The same terms for every project on Balo.</Text>
          <Text style={[styles.termText, { marginTop: 4, marginBottom: 4 }]}>
            {pricingMethodRule(pricingMethod, clientCompanyName)}
          </Text>
          {STANDARD_TERMS.map((term) => (
            <View key={term} style={styles.termRow}>
              <Text style={styles.termMarker}>•</Text>
              <Text style={[styles.termText, styles.termRowText]}>{term}</Text>
            </View>
          ))}
          <Text style={[styles.termText, { marginTop: 4 }]}>
            Read the Project T&amp;Cs at <Link src={projectTermsUrl}>{projectTermsUrl}</Link>
          </Text>
        </View>
      </View>
      {hasAdditional ? (
        <View style={[styles.termsBox, styles.termsBoxRest]}>
          <NumberedRows
            items={additionalTerms}
            lead={
              <>
                <Text style={styles.termsHeading}>{expertName}’s additional terms</Text>
                <Text style={[styles.termText, { marginBottom: 4 }]}>
                  {BALO_TERMS_ADDITIVE_SENTENCE}
                </Text>
              </>
            }
          />
        </View>
      ) : null}
    </View>
  );
}

export function ProposalPdfDocument({
  doc,
  title,
  clientCompanyName,
  preparedByOrgName,
  generatedAtIso,
  projectTermsUrl,
}: Readonly<ProposalPdfDocumentProps>): React.JSX.Element {
  const isTM = doc.pricingMethod === 'tm';
  const preparedBy =
    preparedByOrgName === null ? doc.expert.name : `${doc.expert.name} @ ${preparedByOrgName}`;
  const versionNote =
    doc.version > 1 ? `Version ${doc.version} · revised` : `Version ${doc.version}`;
  const overview = richTextToPdf(doc.overviewHtml);
  const hasScope = doc.assumptions.length > 0 || doc.exclusions.length > 0;

  return (
    <Document title={title} author="Balo">
      <Page size="A4" style={styles.page} wrap>
        <View style={styles.header} fixed>
          <Text style={styles.wordmark}>Balo</Text>
          {/*
            ⚠ THE HELPER, NOT A HARDCODED ARM — the same rule as the web pill. This
            header pill prints on every page of the very document whose SummaryBox
            carries the canonical PRICING cell; it used to read capital-M
            `Time & Materials` against that cell's `Time & materials`. Capital-M is
            RETIRED on both client surfaces (BAL-392).
          */}
          <Text style={styles.pill}>{pricingMethodLabel(doc.pricingMethod)}</Text>
        </View>

        <Text style={styles.title}>{title}</Text>
        <Text style={styles.versionNote}>{versionNote}</Text>

        <Parties clientCompanyName={clientCompanyName} preparedBy={preparedBy} />

        <SummaryBox doc={doc} />

        {overview.length > 0 ? (
          <View style={styles.section}>
            <SectionLabel>OVERVIEW</SectionLabel>
            {overview}
          </View>
        ) : null}

        {doc.milestones.length > 0 ? (
          <View style={styles.section}>
            <SectionLabel>MILESTONES &amp; DELIVERABLES</SectionLabel>
            {doc.milestones.map((milestone, index) => (
              <MilestoneRow
                key={milestone.id}
                milestone={milestone}
                index={index}
                showValue={!isTM}
                currency={doc.currency}
              />
            ))}
          </View>
        ) : null}

        {hasScope ? <AssumptionsAndExclusions doc={doc} /> : null}

        <View style={styles.section}>
          <SectionLabel>PAYMENT TERMS</SectionLabel>
          <PaymentTerms doc={doc} />
        </View>

        <StandardTerms
          pricingMethod={doc.pricingMethod}
          clientCompanyName={clientCompanyName}
          expertName={doc.expert.name}
          additionalTerms={doc.additionalTerms}
          projectTermsUrl={projectTermsUrl}
        />

        {doc.attachments.length > 0 ? (
          <View style={styles.section}>
            <SectionLabel>ATTACHMENTS</SectionLabel>
            {doc.attachments.map((attachment) => (
              <View key={attachment.id} style={styles.attachment}>
                <Text style={styles.attachmentName}>{attachment.fileName}</Text>
              </View>
            ))}
          </View>
        ) : null}

        <Text
          style={styles.footer}
          fixed
          render={({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
            `Version ${doc.version} · Generated ${formatGeneratedDate(generatedAtIso)} · Page ${pageNumber} of ${totalPages}`
          }
        />
      </Page>
    </Document>
  );
}

/**
 * Render the client-facing proposal PDF to a Node Buffer. Kept here (a `.tsx`
 * module) so the JSX element carries `JSX.Element` — assignable to react-pdf's
 * `renderToBuffer` param — and the Route Handler stays JSX-free.
 */
export function renderProposalPdfToBuffer(
  props: Readonly<ProposalPdfDocumentProps>
): Promise<Buffer> {
  return renderToBuffer(<ProposalPdfDocument {...props} />);
}
