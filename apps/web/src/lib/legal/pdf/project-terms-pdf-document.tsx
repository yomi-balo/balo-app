import { Document, Page, StyleSheet, Text, View, renderToBuffer } from '@react-pdf/renderer';
import { PDF_COLORS, PDF_TYPE } from '@/lib/project-request/proposal/pdf/pdf-theme';
import {
  ensurePdfFontsRegistered,
  PDF_FONT_FAMILY,
} from '@/lib/project-request/proposal/pdf/pdf-fonts';
import {
  PROJECT_TERMS,
  PROJECT_TERMS_LAST_UPDATED_LINE,
  PROJECT_TERMS_TITLE,
  PROJECT_TERMS_VERSION,
} from '../project-terms';
import {
  buildClauseIndex,
  clauseLabel,
  formatTermsDate,
  resolveClauseRefs,
  splitEmphasis,
  type TermsNode,
} from '../terms';

ensurePdfFontsRegistered();

const CLAUSE_INDEX = buildClauseIndex(PROJECT_TERMS);

const styles = StyleSheet.create({
  page: {
    fontFamily: PDF_FONT_FAMILY,
    fontSize: PDF_TYPE.body,
    color: PDF_COLORS.text,
    paddingTop: 48,
    paddingBottom: 60,
    paddingHorizontal: 52,
  },
  title: { fontSize: PDF_TYPE.title, fontWeight: 600, marginBottom: 6 },
  dateLine: { color: PDF_COLORS.muted, marginBottom: 18 },
  sectionHeading: { fontSize: PDF_TYPE.h2, fontWeight: 600, marginTop: 14, marginBottom: 6 },
  paragraph: { marginBottom: 6, lineHeight: 1.5 },
  clause: { flexDirection: 'row', marginBottom: 4 },
  label: { fontWeight: 500, lineHeight: 1.5 },
  body: { flex: 1, lineHeight: 1.5 },
  bold: { fontWeight: 700 },
  footer: {
    position: 'absolute',
    bottom: 28,
    left: 52,
    right: 52,
    fontSize: PDF_TYPE.label,
    color: PDF_COLORS.faint,
    textAlign: 'center',
  },
});

function labelWidth(depth: number): number {
  return depth <= 3 ? 34 : 24;
}

/**
 * Text with `**bold**` as real bold. Italic prints upright: Geist has no italic face, and a
 * `skewX` transform makes react-pdf throw (BAL-662 D15).
 */
function Emphasised({ text }: Readonly<{ text: string }>): React.JSX.Element {
  let offset = 0;
  const parts = splitEmphasis(resolveClauseRefs(text, CLAUSE_INDEX)).map((run) => {
    const key = `${offset}-${run.text}`;
    offset += run.text.length;
    return run.emphasis === 'bold' ? (
      <Text key={key} style={styles.bold}>
        {run.text}
      </Text>
    ) : (
      run.text
    );
  });
  return <>{parts}</>;
}

function Clause({
  node,
  path,
}: Readonly<{ node: TermsNode; path: readonly number[] }>): React.JSX.Element {
  const label = clauseLabel(path);
  return (
    <View>
      <View style={styles.clause}>
        <Text style={[styles.label, { width: labelWidth(path.length) }]}>{label}</Text>
        <Text style={styles.body}>
          <Emphasised text={node.text} />
        </Text>
      </View>
      {node.children ? (
        <View style={{ marginLeft: labelWidth(path.length) }}>
          {node.children.map((child, position) => (
            <Clause
              key={clauseLabel([...path, position + 1])}
              node={child}
              path={[...path, position + 1]}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function ProjectTermsPdfDocument(): React.JSX.Element {
  return (
    <Document title={PROJECT_TERMS_TITLE}>
      <Page size="A4" style={styles.page} wrap>
        <Text style={styles.title}>{PROJECT_TERMS_TITLE}</Text>
        <Text style={styles.dateLine}>
          {splitEmphasis(PROJECT_TERMS_LAST_UPDATED_LINE)
            .map((run) => run.text)
            .join('')}
        </Text>
        {PROJECT_TERMS.map((section, sectionPosition) => (
          <View key={section.id}>
            <Text style={styles.sectionHeading}>{`${sectionPosition + 1}. ${section.title}`}</Text>
            {(section.intro ?? []).map((paragraph) => (
              <Text key={paragraph} style={styles.paragraph}>
                <Emphasised text={paragraph} />
              </Text>
            ))}
            {section.clauses.map((clause, position) => (
              <Clause
                key={clauseLabel([sectionPosition + 1, position + 1])}
                node={clause}
                path={[sectionPosition + 1, position + 1]}
              />
            ))}
          </View>
        ))}
        <Text
          style={styles.footer}
          fixed
          render={({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
            `${PROJECT_TERMS_TITLE} · ${formatTermsDate(PROJECT_TERMS_VERSION)} · Page ${pageNumber} of ${totalPages}`
          }
        />
      </Page>
    </Document>
  );
}

export function renderProjectTermsPdfToBuffer(): Promise<Buffer> {
  return renderToBuffer(<ProjectTermsPdfDocument />);
}
