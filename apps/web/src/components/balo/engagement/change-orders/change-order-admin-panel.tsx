import { AlertTriangle, Lock } from 'lucide-react';

import { BaloCard } from '@/components/balo/card/balo-card';
import { cn } from '@/lib/utils';
import { ToneBanner, TonePill } from './change-order-tone';

/**
 * The shape `mapChangeOrderAdminView` produces, restated structurally. The mapper module is
 * imported by the workspace page alone (fee concealment), so this component reads its output
 * through the matching props type rather than importing it; the page's prop assignment is the
 * compile-time check that the two stay equal.
 */
export type ChangeOrderAdminMoneyView =
  | {
      kind: 'fixed';
      rows: { label: string; expert: string; client: string; margin: string; strong: boolean }[];
      upfrontLabel: string;
      finalInvoiceLabel: string;
      finalInvoiceNegative: boolean;
      pendingNote: string | null;
      creditNeededText: string | null;
      footnote: string;
    }
  | {
      kind: 'tm';
      rows: { label: string; value: string; strong: boolean }[];
      pendingNote: string | null;
      footnote: string;
    };

interface ChangeOrderAdminPanelProps {
  money: ChangeOrderAdminMoneyView;
}

const LABEL_CELL = 'py-2 pr-3';

/**
 * The Balo-staff money panel: both sides of every amount, the margin, the current price and the
 * final-invoice figure (fixed price), or the estimate telescope (time and materials). Server
 * safe and presentational. The caller renders it only behind the platform capability; nothing
 * here reads a role.
 */
export function ChangeOrderAdminPanel({
  money,
}: Readonly<ChangeOrderAdminPanelProps>): React.JSX.Element {
  const title = money.kind === 'fixed' ? 'Price and final invoice' : 'Hours and changes';
  return (
    <BaloCard as="section" aria-label={title} className="border-foreground/20 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-foreground text-sm font-semibold">{title}</h2>
        <TonePill icon={Lock}>Balo staff only</TonePill>
      </div>

      <div className="mt-3 overflow-x-auto">
        {money.kind === 'fixed' ? <FixedTable money={money} /> : <TimeTable money={money} />}
      </div>

      {money.pendingNote !== null && (
        <p className="text-muted-foreground mt-3 text-xs">{money.pendingNote}</p>
      )}
      {money.kind === 'fixed' && money.creditNeededText !== null && (
        <div className="mt-3">
          <ToneBanner tone="destructive" icon={AlertTriangle} label="Credit needed">
            {money.creditNeededText}
          </ToneBanner>
        </div>
      )}
      <p className="text-muted-foreground mt-3 text-xs">{money.footnote}</p>
    </BaloCard>
  );
}

function TimeTable({
  money,
}: Readonly<{ money: Extract<ChangeOrderAdminMoneyView, { kind: 'tm' }> }>): React.JSX.Element {
  return (
    <table className="w-full text-left text-sm">
      <tbody className="divide-border divide-y">
        {money.rows.map((row) => (
          <tr key={row.label}>
            <td
              className={cn(
                LABEL_CELL,
                row.strong ? 'text-foreground font-medium' : 'text-muted-foreground'
              )}
            >
              {row.label}
            </td>
            <td
              className={cn(
                'py-2 text-right font-mono tabular-nums',
                row.strong ? 'text-foreground font-semibold' : 'text-foreground'
              )}
            >
              {row.value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FixedTable({
  money,
}: Readonly<{ money: Extract<ChangeOrderAdminMoneyView, { kind: 'fixed' }> }>): React.JSX.Element {
  return (
    <table className="w-full min-w-[520px] text-left text-sm">
      <thead>
        <tr className="text-muted-foreground text-xs">
          <th scope="col" className="pr-3 pb-2 font-medium">
            <span className="sr-only">Line</span>
          </th>
          <th scope="col" className="pr-3 pb-2 text-right font-medium">
            Expert
          </th>
          <th scope="col" className="pr-3 pb-2 text-right font-medium">
            Client
          </th>
          <th scope="col" className="pb-2 text-right font-medium">
            Balo margin
          </th>
        </tr>
      </thead>
      <tbody className="divide-border divide-y">
        {money.rows.map((row) => (
          <tr key={row.label}>
            <td
              className={cn(
                LABEL_CELL,
                row.strong ? 'text-foreground font-medium' : 'text-muted-foreground'
              )}
            >
              {row.label}
            </td>
            <td className="text-foreground py-2 pr-3 text-right font-mono tabular-nums">
              {row.expert}
            </td>
            <td className="text-foreground py-2 pr-3 text-right font-mono tabular-nums">
              {row.client}
            </td>
            <td className="text-muted-foreground py-2 text-right font-mono tabular-nums">
              {row.margin}
            </td>
          </tr>
        ))}
        <tr>
          <td className={cn(LABEL_CELL, 'text-muted-foreground')}>Already invoiced upfront</td>
          <td className="text-muted-foreground py-2 pr-3 text-right">—</td>
          <td className="text-foreground py-2 pr-3 text-right font-mono tabular-nums">
            {money.upfrontLabel}
          </td>
          <td className="text-muted-foreground py-2 text-right">—</td>
        </tr>
        <tr>
          <td className={cn(LABEL_CELL, 'text-foreground font-medium')}>Final invoice</td>
          <td className="text-muted-foreground py-2 pr-3 text-right">—</td>
          <td
            className={cn(
              'py-2 pr-3 text-right font-mono font-semibold tabular-nums',
              money.finalInvoiceNegative ? 'text-destructive' : 'text-foreground'
            )}
          >
            {money.finalInvoiceLabel}
          </td>
          <td className="text-muted-foreground py-2 text-right">—</td>
        </tr>
      </tbody>
    </table>
  );
}
