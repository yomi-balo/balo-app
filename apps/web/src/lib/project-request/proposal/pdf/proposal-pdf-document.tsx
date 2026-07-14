import { Document, Page, StyleSheet, Text, View, renderToBuffer } from '@react-pdf/renderer';
import { formatWholeCurrency } from '@/lib/utils/currency';
import { STANDARD_TERMS } from '@/components/balo/project-request/proposal/proposal-standard-terms';
import type {
  ProposalReviewAttachment,
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
  banner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    borderWidth: 1,
    borderColor: PDF_COLORS.brandBorder,
    backgroundColor: PDF_COLORS.brandSoft,
    borderRadius: 10,
    padding: 16,
    marginTop: 16,
  },
  bannerLabel: {
    fontSize: PDF_TYPE.label,
    fontWeight: 700,
    color: PDF_COLORS.muted,
    letterSpacing: 0.6,
    marginBottom: 3,
  },
  money: { fontSize: PDF_TYPE.money, fontWeight: 700, color: PDF_COLORS.text },
  moneyEst: { fontSize: PDF_TYPE.body, fontWeight: 600, color: PDF_COLORS.muted },
  timeframe: { fontSize: PDF_TYPE.h3, fontWeight: 600, color: PDF_COLORS.text },
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
  termText: { flex: 1, fontSize: PDF_TYPE.small, color: PDF_COLORS.muted, lineHeight: 1.5 },
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

function MoneyBanner({ doc }: Readonly<{ doc: ProposalReviewDoc }>): React.JSX.Element {
  const isTM = doc.pricingMethod === 'tm';
  return (
    <View style={styles.banner}>
      <View>
        <Text style={styles.bannerLabel}>{isTM ? 'ESTIMATED TOTAL' : 'FIXED PRICE'}</Text>
        <Text style={styles.money}>
          {formatWholeCurrency(doc.priceCents, doc.currency)}
          {isTM ? <Text style={styles.moneyEst}> est.</Text> : null}
        </Text>
      </View>
      <View>
        <Text style={styles.bannerLabel}>EST. TIMEFRAME</Text>
        <Text style={styles.timeframe}>
          {doc.timeframeWeeks === null ? '—' : `~${doc.timeframeWeeks} weeks`}
        </Text>
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
  const description = richTextToPdf(milestone.descriptionHtml);
  const hasAcceptance =
    milestone.acceptanceCriteria !== null && milestone.acceptanceCriteria !== '';
  return (
    <View style={styles.milestone} wrap={false}>
      <View style={styles.milestoneHead}>
        <Text style={styles.milestoneTitle}>
          {index + 1}. {milestone.title}
        </Text>
        {showValue && milestone.valueCents !== null ? (
          <Text style={styles.milestoneValue}>
            {formatWholeCurrency(milestone.valueCents, currency)}
          </Text>
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

function StandardTerms({
  termsSupplement,
}: Readonly<{ termsSupplement: ProposalReviewAttachment | undefined }>): React.JSX.Element {
  return (
    <View style={styles.termsBox}>
      <Text style={styles.termsHeading}>Balo standard terms apply</Text>
      {STANDARD_TERMS.map((term) => (
        <View key={term} style={styles.termRow}>
          <Text style={styles.termMarker}>•</Text>
          <Text style={styles.termText}>{term}</Text>
        </View>
      ))}
      {termsSupplement !== undefined && (
        <Text style={[styles.termText, { marginTop: 4 }]}>
          Additional terms attached: {termsSupplement.fileName}
        </Text>
      )}
    </View>
  );
}

export function ProposalPdfDocument({
  doc,
  title,
  clientCompanyName,
  preparedByOrgName,
  generatedAtIso,
}: Readonly<ProposalPdfDocumentProps>): React.JSX.Element {
  const isTM = doc.pricingMethod === 'tm';
  const preparedBy =
    preparedByOrgName === null ? doc.expert.name : `${doc.expert.name} @ ${preparedByOrgName}`;
  const versionNote =
    doc.version > 1 ? `Version ${doc.version} · revised` : `Version ${doc.version}`;
  const overview = richTextToPdf(doc.overviewHtml);
  const exclusions = richTextToPdf(doc.exclusionsHtml);
  const termsSupplement = doc.attachments.find((attachment) => attachment.kind === 'terms');
  const fileAttachments = doc.attachments.filter((attachment) => attachment.kind !== 'terms');

  return (
    <Document title={title} author="Balo">
      <Page size="A4" style={styles.page} wrap>
        <View style={styles.header} fixed>
          <Text style={styles.wordmark}>Balo</Text>
          <Text style={styles.pill}>{isTM ? 'Time & Materials' : 'Fixed price'}</Text>
        </View>

        <Text style={styles.title}>{title}</Text>
        <Text style={styles.versionNote}>{versionNote}</Text>

        <Parties clientCompanyName={clientCompanyName} preparedBy={preparedBy} />

        <MoneyBanner doc={doc} />

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

        <View style={styles.section}>
          <SectionLabel>PAYMENT TERMS</SectionLabel>
          <PaymentTerms doc={doc} />
        </View>

        {exclusions.length > 0 ? (
          <View style={styles.section}>
            <SectionLabel>NOT INCLUDED</SectionLabel>
            {exclusions}
          </View>
        ) : null}

        {fileAttachments.length > 0 ? (
          <View style={styles.section}>
            <SectionLabel>ATTACHMENTS</SectionLabel>
            {fileAttachments.map((attachment) => (
              <View key={attachment.id} style={styles.attachment}>
                <Text style={styles.attachmentName}>{attachment.fileName}</Text>
              </View>
            ))}
          </View>
        ) : null}

        <View style={styles.section}>
          <SectionLabel>TERMS</SectionLabel>
          <StandardTerms termsSupplement={termsSupplement} />
        </View>

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
